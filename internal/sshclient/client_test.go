package sshclient

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Sanjeever/ssh-mcp/internal/config"
	"github.com/Sanjeever/ssh-mcp/internal/testssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func fmtPort(port int) string { return strconv.Itoa(port) }

func testConfig(s *testssh.Server) config.Server {
	return config.Server{ID: "test", Host: s.Host, Port: s.Port, Username: "operator", Password: " secret "}
}
func trustPath(t *testing.T) string { return filepath.Join(t.TempDir(), ".ssh", "known_hosts") }

func TestPasswordAndPrivateKeyAuthentication(t *testing.T) {
	s := testssh.Start(t)
	cfg := testConfig(s)
	path := trustPath(t)
	for _, kind := range []string{"password", "key", "encrypted"} {
		t.Run(kind, func(t *testing.T) {
			c := cfg
			if kind != "password" {
				c.Password = ""
				c.PrivateKeyPath = filepath.Join(t.TempDir(), "key")
				data := s.PrivateKey
				if kind == "encrypted" {
					data = s.EncryptedKey
					c.Passphrase = " pass "
				}
				if err := os.WriteFile(c.PrivateKeyPath, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			}
			client, err := Dial(context.Background(), c, path, "accept_new")
			if err != nil {
				t.Fatal(err)
			}
			client.Close()
		})
	}
	cfg.Password = "wrong"
	if _, err := Dial(context.Background(), cfg, path, "strict"); ErrorCode(err) != "ssh_auth_failed" {
		t.Fatal(err)
	}
	if s.AuthCount.Load() < 4 {
		t.Fatal("未执行认证")
	}
}

func TestKnownHostsRulesAndPreservation(t *testing.T) {
	s := testssh.Start(t)
	other := testssh.Start(t)
	addr := net.JoinHostPort(s.Host, fmtPort(s.Port))
	remote := &net.TCPAddr{IP: net.ParseIP(s.Host), Port: s.Port}
	for _, hashed := range []bool{false, true} {
		path := filepath.Join(t.TempDir(), "known_hosts")
		host := knownhosts.Normalize(addr)
		if hashed {
			host = knownhosts.HashHostname(host)
		}
		original := "# 保留注释\n" + knownhosts.Line([]string{host}, s.Key)
		if err := os.WriteFile(path, []byte(original), 0640); err != nil {
			t.Fatal(err)
		}
		if err := hostKeyCallback(path, "strict")(addr, remote, s.Key); err != nil {
			t.Fatal(err)
		}
		if err := hostKeyCallback(path, "accept_new")(addr, remote, other.Key); ErrorCode(err) != "ssh_host_key_rejected" {
			t.Fatal(err)
		}
		newAddr := net.JoinHostPort("localhost", fmtPort(s.Port))
		if err := hostKeyCallback(path, "accept_new")(newAddr, remote, s.Key); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(path)
		if !strings.HasPrefix(string(data), original+"\n") {
			t.Fatal("原内容或换行未保留")
		}
		info, _ := os.Stat(path)
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0640 {
			t.Fatal("权限被修改")
		}
	}
	path := trustPath(t)
	if err := hostKeyCallback(path, "strict")(addr, remote, s.Key); err == nil {
		t.Fatal("strict 接受缺失信任文件")
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("strict 创建了目录")
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			if err := hostKeyCallback(path, "accept_new")(addr, remote, s.Key); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	data, _ := os.ReadFile(path)
	if strings.Count(string(data), "\n") != 1 {
		t.Fatal("重复追加")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		dir, _ := os.Stat(filepath.Dir(path))
		if info.Mode().Perm() != 0600 || dir.Mode().Perm() != 0700 {
			t.Fatal("新建权限错误")
		}
	}
	for _, line := range []string{"损坏内容\n", "@revoked " + knownhosts.Line([]string{addr}, s.Key) + "\n"} {
		if err := os.WriteFile(path, []byte(line), 0600); err != nil {
			t.Fatal(err)
		}
		if err := hostKeyCallback(path, "accept_new")(addr, remote, s.Key); err == nil {
			t.Fatal("接受损坏或撤销记录")
		}
	}
}

func TestKnownHostsSymlinkAndWriteFailure(t *testing.T) {
	s := testssh.Start(t)
	addr := net.JoinHostPort(s.Host, fmtPort(s.Port))
	remote := &net.TCPAddr{IP: net.ParseIP(s.Host), Port: s.Port}
	path := filepath.Join(t.TempDir(), "known_hosts")
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("# 原内容"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("当前 Windows 账号未获符号链接权限")
		}
		t.Fatal(err)
	}
	if err := hostKeyCallback(path, "accept_new")(addr, remote, s.Key); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Lstat(path); info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("符号链接被替换")
	}
	if runtime.GOOS != "windows" {
		os.Chmod(target, 0400)
		defer os.Chmod(target, 0600)
		if err := hostKeyCallback(path, "accept_new")(net.JoinHostPort("unknown", fmtPort(s.Port)), remote, s.Key); ErrorCode(err) != "ssh_known_hosts_write" {
			t.Fatal(err)
		}
	}
}

func TestHandshakeCancellation(t *testing.T) {
	testHandshakeDeadline(t, 100*time.Millisecond, "ssh_timeout")
}

func TestHandshakeTimeout(t *testing.T) {
	testHandshakeDeadline(t, HandshakeTimeout+5*time.Second, "ssh_handshake_timeout")
}

func testHandshakeDeadline(t *testing.T, timeout time.Duration, wantCode string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		raw, err := listener.Accept()
		if err == nil {
			defer raw.Close()
			buffer := make([]byte, 256)
			for {
				if _, err := raw.Read(buffer); err != nil {
					return
				}
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cfg := config.Server{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "operator", Password: " secret "}
	if _, err := Dial(ctx, cfg, trustPath(t), "accept_new"); ErrorCode(err) != wantCode {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("握手取消未关闭连接")
	}
}
