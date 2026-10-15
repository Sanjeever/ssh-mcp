package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func base() []string {
	return []string{"SSH_MCP_SERVER_PROD_DB_HOST=::1", "SSH_MCP_SERVER_PROD_DB_USERNAME=deploy", "SSH_MCP_SERVER_PROD_DB_PASSWORD= secret = "}
}

func TestGroupingDefaultsAndPaths(t *testing.T) {
	key := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(key, []byte("测试文件"), 0600); err != nil {
		t.Fatal(err)
	}
	env := append(base(), "SSH_MCP_SERVER_DEV_HOST=localhost", "SSH_MCP_SERVER_DEV_USERNAME=user", "SSH_MCP_SERVER_DEV_PRIVATE_KEY_PATH="+key, "SSH_MCP_SERVER_DEV_PASSPHRASE= pass ", "SSH_MCP_SERVER_DEV_PORT=2222", "SSH_MCP_SERVER_DEV_DESCRIPTION=开发")
	c, err := Load(env)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Servers) != 2 || c.HostKeyPolicy != "accept_new" || !filepath.IsAbs(c.KnownHosts) {
		t.Fatalf("默认配置错误：%+v", c)
	}
	if s := c.Servers["prod_db"]; s.ID != "prod_db" || s.Port != 22 || s.Password != " secret = " || s.AuthType() != "password" {
		t.Fatal("分组或密码被更改")
	}
	if s := c.Servers["dev"]; s.PrivateKeyPath != key || s.Passphrase != " pass " || s.Port != 2222 || s.AuthType() != "private_key" {
		t.Fatal("私钥配置错误")
	}
	p, err := ResolvePath("$SSH_MCP_TEST_LITERAL/file")
	if err != nil || !strings.Contains(p, "$SSH_MCP_TEST_LITERAL") {
		t.Fatal("不应展开环境变量")
	}
}

func TestInvalidConfigDoesNotLeakSecrets(t *testing.T) {
	for _, extra := range []string{"SSH_MCP_SERVER_bad_HOST=secret", "SSH_MCP_SERVER_DEV_TOKEN=secret", "SSH_MCP_SERVER_PROD_DB_PORT=secret", "SSH_MCP_SERVER_PROD_DB_PORT=65536", "SSH_MCP_SERVER_PROD_DB_PRIVATE_KEY_PATH=secret", "SSH_MCP_SERVER_PROD_DB_PASSPHRASE=secret", "SSH_MCP_SERVER_PROD_DB_USERNAME=", "SSH_MCP_SERVER_PROD_DB_HOST=localhost:22", "SSH_MCP_HOST_KEY_POLICY=secret", "SSH_MCP_KNOWN_HOSTS=~secret", "SSH_MCP_SERVER_PROD_DB_PASSWORD="} {
		t.Run(extra, func(t *testing.T) {
			_, err := Load(append(base(), extra))
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("错误缺失或泄露凭据：%v", err)
			}
		})
	}
	if _, err := Load(nil); err == nil {
		t.Fatal("空配置被接受")
	}
}
