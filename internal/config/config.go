package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type Server struct {
	ID, Description, Host, Username      string
	Port                                 int
	Password, PrivateKeyPath, Passphrase string
}

func (s Server) AuthType() string {
	if s.PrivateKeyPath != "" {
		return "private_key"
	}
	return "password"
}

type Config struct {
	Servers                   map[string]Server
	HostKeyPolicy, KnownHosts string
}

var idPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// 后缀按长度递减匹配，避免将私钥字段或带下划线的 ID 拆错。
var fields = []string{"PRIVATE_KEY_PATH", "DESCRIPTION", "PASSPHRASE", "USERNAME", "PASSWORD", "HOST", "PORT"}

func Load(environ []string) (Config, error) {
	c := Config{Servers: make(map[string]Server), HostKeyPolicy: "accept_new"}
	groups := make(map[string]map[string]string)
	knownPath := "~/.ssh/known_hosts"
	for _, entry := range environ {
		name, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch name {
		case "SSH_MCP_HOST_KEY_POLICY":
			c.HostKeyPolicy = value
			continue
		case "SSH_MCP_KNOWN_HOSTS":
			knownPath = value
			continue
		}
		if !strings.HasPrefix(name, "SSH_MCP_SERVER_") {
			continue
		}
		rest := strings.TrimPrefix(name, "SSH_MCP_SERVER_")
		id, field := "", ""
		for _, candidate := range fields {
			if strings.HasSuffix(rest, "_"+candidate) {
				id, field = strings.TrimSuffix(rest, "_"+candidate), candidate
				break
			}
		}
		if field == "" {
			return c, fmt.Errorf("服务器环境变量包含未知字段（名称未显示以保护凭据）")
		}
		if !idPattern.MatchString(id) {
			return c, fmt.Errorf("服务器 ID 必须以大写字母开头，且仅含大写字母、数字和下划线")
		}
		if groups[id] == nil {
			groups[id] = make(map[string]string)
		}
		groups[id][field] = value
	}
	if c.HostKeyPolicy != "accept_new" && c.HostKeyPolicy != "strict" {
		return c, fmt.Errorf("SSH_MCP_HOST_KEY_POLICY 必须为 accept_new 或 strict")
	}
	var err error
	c.KnownHosts, err = ResolvePath(knownPath)
	if err != nil {
		return c, fmt.Errorf("known_hosts 路径无效：%w", err)
	}
	if len(groups) == 0 {
		return c, fmt.Errorf("至少需要配置一台 SSH 服务器")
	}
	ids := make([]string, 0, len(groups))
	for id := range groups {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		g := groups[id]
		s := Server{ID: strings.ToLower(id), Host: strings.TrimSpace(g["HOST"]), Username: strings.TrimSpace(g["USERNAME"]), Description: g["DESCRIPTION"], Port: 22, Password: g["PASSWORD"], Passphrase: g["PASSPHRASE"]}
		if s.Host == "" || s.Username == "" {
			return c, fmt.Errorf("服务器 %s 缺少 HOST 或 USERNAME", s.ID)
		}
		if strings.ContainsAny(s.Host, " /\\\t\r\n") || (strings.Contains(s.Host, ":") && net.ParseIP(s.Host) == nil) {
			return c, fmt.Errorf("服务器 %s 的 HOST 必须是主机名或 IP，端口须单独配置", s.ID)
		}
		if port, exists := g["PORT"]; exists {
			s.Port, err = strconv.Atoi(port)
			if err != nil || s.Port < 1 || s.Port > 65535 {
				return c, fmt.Errorf("服务器 %s 的 PORT 必须为 1–65535 的整数", s.ID)
			}
		}
		_, password := g["PASSWORD"]
		keyPath, key := g["PRIVATE_KEY_PATH"]
		if password == key || (password && s.Password == "") || (key && strings.TrimSpace(keyPath) == "") {
			return c, fmt.Errorf("服务器 %s 必须配置 PASSWORD 或 PRIVATE_KEY_PATH，且两者互斥、不能为空", s.ID)
		}
		if _, exists := g["PASSPHRASE"]; exists && !key {
			return c, fmt.Errorf("服务器 %s 的 PASSPHRASE 仅适用于私钥认证", s.ID)
		}
		if key {
			s.PrivateKeyPath, err = ResolvePath(keyPath)
			if err != nil {
				return c, fmt.Errorf("服务器 %s 的私钥路径无效：%w", s.ID, err)
			}
			info, statErr := os.Stat(s.PrivateKeyPath)
			if statErr != nil || !info.Mode().IsRegular() {
				return c, fmt.Errorf("服务器 %s 的私钥文件不存在、不可访问或不是普通文件", s.ID)
			}
		}
		c.Servers[s.ID] = s
	}
	return c, nil
}

func ResolvePath(value string) (string, error) {
	if value == "" || strings.ContainsRune(value, 0) {
		return "", fmt.Errorf("路径不能为空或包含空字节")
	}
	if value == "~" || strings.HasPrefix(value, "~/") || (runtime.GOOS == "windows" && strings.HasPrefix(value, `~\`)) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("无法获取用户主目录")
		}
		if len(value) == 1 {
			value = home
		} else {
			value = filepath.Join(home, value[2:])
		}
	} else if strings.HasPrefix(value, "~") {
		return "", fmt.Errorf("不支持命名用户主目录写法")
	}
	path, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("无法解析绝对路径")
	}
	return path, nil
}
