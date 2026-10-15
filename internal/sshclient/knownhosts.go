package sshclient

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// 同一进程内共享检查和追加锁，不协调外部 OpenSSH 进程。
var trustMu sync.Mutex

func hostKeyCallback(path, policy string) ssh.HostKeyCallback {
	return func(host string, remote net.Addr, key ssh.PublicKey) error {
		trustMu.Lock()
		defer trustMu.Unlock()
		callback, err := knownhosts.New(path)
		if errors.Is(err, os.ErrNotExist) && policy == "accept_new" {
			if _, linkErr := os.Lstat(path); linkErr == nil {
				return failure("ssh_known_hosts_invalid", "known_hosts 入口存在但目标不可读取")
			}
		} else if err != nil {
			return failure("ssh_known_hosts_invalid", "known_hosts 缺失、损坏或不可读取；连接已拒绝")
		}
		if err == nil {
			err = callback(host, remote, key)
			if err == nil {
				return nil
			}
			var unknown *knownhosts.KeyError
			if !errors.As(err, &unknown) || len(unknown.Want) != 0 {
				return failure("ssh_host_key_rejected", "SSH 主机密钥变化、被撤销或不符合信任规则；连接已拒绝，请核对服务器身份")
			}
		}
		if policy != "accept_new" {
			return failure("ssh_host_unknown", "strict 策略拒绝未知 SSH 主机，请先核对并配置 known_hosts")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return failure("ssh_known_hosts_write", "无法创建 known_hosts 父目录")
		}
		file, err := os.OpenFile(path, os.O_RDWR|os.O_APPEND|os.O_CREATE, 0600)
		if err != nil {
			return failure("ssh_known_hosts_write", "无法打开 known_hosts 追加信任记录")
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return failure("ssh_known_hosts_write", "known_hosts 必须是可读写的普通文件")
		}
		// 打开后重新校验，避免本进程并发调用重复追加或接受冲突密钥。
		callback, err = knownhosts.New(path)
		if err != nil {
			return failure("ssh_known_hosts_invalid", "追加前读取 known_hosts 失败")
		}
		err = callback(host, remote, key)
		if err == nil {
			return nil
		}
		var unknown *knownhosts.KeyError
		if !errors.As(err, &unknown) || len(unknown.Want) != 0 {
			return failure("ssh_host_key_rejected", "追加前发现主机密钥冲突或撤销，连接已拒绝")
		}
		prefix := ""
		if info.Size() > 0 {
			var last [1]byte
			if _, err := file.ReadAt(last[:], info.Size()-1); err != nil {
				return failure("ssh_known_hosts_write", "无法读取 known_hosts 末尾")
			}
			if last[0] != '\n' {
				prefix = "\n"
			}
		}
		if _, err := file.WriteString(prefix + knownhosts.Line([]string{host}, key) + "\n"); err != nil {
			return failure("ssh_known_hosts_write", "known_hosts 追加失败，未建立信任")
		}
		if err := file.Sync(); err != nil {
			return failure("ssh_known_hosts_write", "known_hosts 同步失败，连接已拒绝")
		}
		if err := file.Close(); err != nil {
			return failure("ssh_known_hosts_write", "known_hosts 关闭失败，连接已拒绝")
		}
		return nil
	}
}
