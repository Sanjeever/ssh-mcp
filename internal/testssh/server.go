// Package testssh 提供仅监听环回地址的 SSH/SFTP 测试服务，文件位于临时目录。
package testssh

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type Server struct {
	Host                           string
	Port                           int
	Root, PrivateKey, EncryptedKey string
	Key                            ssh.PublicKey
	AuthCount                      atomic.Int64
	HangSFTP, HangSession          atomic.Bool
	CutSFTP                        atomic.Bool
}

func Start(t testing.TB) *Server {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(private, "")
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := ssh.MarshalPrivateKeyWithPassphrase(private, "", []byte(" pass "))
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	number, _ := strconv.Atoi(port)
	s := &Server{Host: host, Port: number, Root: t.TempDir(), Key: signer.PublicKey(), PrivateKey: string(pem.EncodeToMemory(block)), EncryptedKey: string(pem.EncodeToMemory(encrypted))}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(meta ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			s.AuthCount.Add(1)
			if meta.User() == "operator" && string(password) == " secret " {
				return nil, nil
			}
			return nil, errors.New("认证拒绝")
		},
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			s.AuthCount.Add(1)
			if meta.User() == "operator" && bytes.Equal(key.Marshal(), s.Key.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("认证拒绝")
		},
	}
	cfg.AddHostKey(signer)
	var wg sync.WaitGroup
	var mu sync.Mutex
	connections := make(map[net.Conn]bool)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			raw, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections[raw] = true
			mu.Unlock()
			wg.Go(func() {
				defer func() { raw.Close(); mu.Lock(); delete(connections, raw); mu.Unlock() }()
				conn, channels, requests, err := ssh.NewServerConn(raw, cfg)
				if err != nil {
					return
				}
				defer conn.Close()
				done := make(chan struct{})
				wg.Go(func() { conn.Wait(); close(done) })
				wg.Go(func() { ssh.DiscardRequests(requests) })
				for incoming := range channels {
					if incoming.ChannelType() != "session" {
						incoming.Reject(ssh.UnknownChannelType, "不支持")
						continue
					}
					if s.HangSession.Load() {
						<-done
						return
					}
					stream, reqs, err := incoming.Accept()
					if err != nil {
						continue
					}
					wg.Go(func() {
						defer stream.Close()
						for req := range reqs {
							switch req.Type {
							case "subsystem":
								var payload struct{ Name string }
								ssh.Unmarshal(req.Payload, &payload)
								if payload.Name != "sftp" {
									req.Reply(false, nil)
									return
								}
								req.Reply(true, nil)
								if s.HangSFTP.Load() {
									<-done
									return
								}
								var transport io.ReadWriteCloser = stream
								if s.CutSFTP.Load() {
									transport = &cutStream{ReadWriteCloser: stream, remaining: 64 * 1024}
								}
								files, err := sftp.NewServer(transport, sftp.WithServerWorkingDirectory(s.Root))
								if err != nil {
									return
								}
								files.Serve()
								files.Close()
								return
							case "exec":
								var payload struct{ Command string }
								ssh.Unmarshal(req.Payload, &payload)
								req.Reply(true, nil)
								status := uint32(0)
								switch payload.Command {
								case "hang":
									<-done
									return
								case "missing":
									io.WriteString(stream, "partial\n")
									return
								case "fail":
									io.WriteString(stream, "partial output\n")
									io.WriteString(stream.Stderr(), "failure detail\n")
									status = 7
								case "large":
									chunk := bytes.Repeat([]byte("测"), 32*1024)
									for range 40 {
										if _, err := stream.Write(chunk); err != nil {
											return
										}
									}
								case "invalid":
									stream.Write([]byte{0xff, 0xfe, 'x'})
								default:
									io.WriteString(stream, "remote ok\n")
									io.WriteString(stream.Stderr(), "remote warning\n")
								}
								stream.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
								return
							default:
								req.Reply(false, nil)
							}
						}
					})
				}
			})
		}
	}()
	t.Cleanup(func() {
		listener.Close()
		mu.Lock()
		for raw := range connections {
			raw.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	return s
}

// 在真实 SFTP 数据流中切断响应，覆盖部分下载后的失败清理行为。
type cutStream struct {
	io.ReadWriteCloser
	remaining int
}

func (s *cutStream) Write(data []byte) (int, error) {
	if len(data) > s.remaining {
		n, _ := s.ReadWriteCloser.Write(data[:s.remaining])
		s.ReadWriteCloser.Close()
		return n, io.ErrUnexpectedEOF
	}
	n, err := s.ReadWriteCloser.Write(data)
	s.remaining -= n
	return n, err
}
