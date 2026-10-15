package sshclient

import (
	"context"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Sanjeever/ssh-mcp/internal/config"
	"golang.org/x/crypto/ssh"
)

const (
	HandshakeTimeout            = 15 * time.Second
	DefaultTimeoutSeconds       = 180
	MaxTimeoutSeconds           = 3600
	MaxOutputBytes              = 128 * 1024
	MaxTransferBytes      int64 = 128 * 1024 * 1024
)

type Client struct {
	*ssh.Client
	stop func() bool
}

func (c *Client) Close() error { c.stop(); return c.Client.Close() }

func Dial(ctx context.Context, server config.Server, knownHosts, policy string) (*Client, error) {
	if ctx.Err() != nil {
		return nil, interrupted(ctx)
	}
	var auth ssh.AuthMethod
	if server.PrivateKeyPath != "" {
		data, err := os.ReadFile(server.PrivateKeyPath)
		if err != nil {
			return nil, failure("ssh_credentials_invalid", "无法读取 SSH 私钥文件")
		}
		var signer ssh.Signer
		if server.Passphrase == "" {
			signer, err = ssh.ParsePrivateKey(data)
		} else {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(data, []byte(server.Passphrase))
		}
		if err != nil {
			return nil, failure("ssh_credentials_invalid", "SSH 私钥无效或私钥口令错误")
		}
		auth = ssh.PublicKeys(signer)
	} else {
		auth = ssh.Password(server.Password)
	}
	address := net.JoinHostPort(server.Host, strconv.Itoa(server.Port))
	handshakeCtx, cancel := context.WithTimeout(ctx, HandshakeTimeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(handshakeCtx, "tcp", address)
	if err != nil {
		if ctx.Err() != nil {
			return nil, interrupted(ctx)
		}
		if handshakeCtx.Err() != nil {
			return nil, failure("ssh_handshake_timeout", "SSH 连接或认证握手超过 15 秒")
		}
		return nil, failure("ssh_connect_failed", "SSH TCP 连接失败，请检查网络、地址和端口")
	}
	stop := context.AfterFunc(ctx, func() { _ = connection.Close() })
	deadline, _ := handshakeCtx.Deadline()
	if err := connection.SetDeadline(deadline); err != nil {
		stop()
		connection.Close()
		return nil, failure("ssh_connect_failed", "无法设置 SSH 握手期限")
	}
	conn, channels, requests, err := ssh.NewClientConn(connection, address, &ssh.ClientConfig{User: server.Username, Auth: []ssh.AuthMethod{auth}, HostKeyCallback: hostKeyCallback(knownHosts, policy)})
	if err != nil {
		stop()
		connection.Close()
		if ctx.Err() != nil {
			return nil, interrupted(ctx)
		}
		var typed *Error
		if errors.As(err, &typed) {
			return nil, typed
		}
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return nil, failure("ssh_handshake_timeout", "SSH 连接或认证握手超过 15 秒")
		}
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, failure("ssh_auth_failed", "SSH 认证失败，请检查服务器账号和凭据")
		}
		return nil, failure("ssh_handshake_failed", "SSH 握手失败，请检查服务器 SSH 配置")
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		stop()
		conn.Close()
		return nil, failure("ssh_connect_failed", "无法清除 SSH 握手期限")
	}
	return &Client{Client: ssh.NewClient(conn, channels, requests), stop: stop}, nil
}
