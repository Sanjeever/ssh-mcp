package sshclient

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

type ExecResult struct {
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	ExitCode        *int   `json:"exit_code"`
	OutputTruncated bool   `json:"output_truncated"`
}

type capture struct {
	mu             sync.Mutex
	stdout, stderr bytes.Buffer
	remaining      int
	truncated      bool
}
type captureWriter struct {
	c      *capture
	stderr bool
}

func (w captureWriter) Write(data []byte) (int, error) {
	w.c.mu.Lock()
	defer w.c.mu.Unlock()
	n := min(len(data), w.c.remaining)
	if n < len(data) {
		w.c.truncated = true
	}
	if w.stderr {
		w.c.stderr.Write(data[:n])
	} else {
		w.c.stdout.Write(data[:n])
	}
	w.c.remaining -= n
	return len(data), nil // 始终继续排空 SSH 输出，避免远端阻塞。
}
func cleanOutput(data []byte) string {
	// 丢弃截断边界处不完整的 UTF-8 序列，内部非法字节用短 ASCII 标记替代。
	for n := 1; n <= 3 && n <= len(data); n++ {
		start := len(data) - n
		if utf8.RuneStart(data[start]) && !utf8.FullRune(data[start:]) {
			data = data[:start]
			break
		}
	}
	return strings.ToValidUTF8(string(data), "?")
}

func (c *Client) Exec(ctx context.Context, command string) (ExecResult, error) {
	var result ExecResult
	stop := context.AfterFunc(ctx, func() { _ = c.Client.Close() })
	defer stop()
	if ctx.Err() != nil {
		return result, interrupted(ctx)
	}
	session, err := c.NewSession()
	if err != nil {
		if ctx.Err() != nil {
			return result, interrupted(ctx)
		}
		return result, failure("ssh_exec_failed", "SSH 会话创建失败")
	}
	defer session.Close()
	cap := &capture{remaining: MaxOutputBytes}
	session.Stdout = captureWriter{c: cap}
	session.Stderr = captureWriter{c: cap, stderr: true}
	err = session.Run(command)
	result.Stdout = cleanOutput(cap.stdout.Bytes())
	result.Stderr = cleanOutput(cap.stderr.Bytes())
	result.OutputTruncated = cap.truncated
	if ctx.Err() != nil {
		return result, interrupted(ctx)
	}
	if err == nil {
		zero := 0
		result.ExitCode = &zero
		return result, nil
	}
	var exit *ssh.ExitError
	if errors.As(err, &exit) && exit.ExitStatus() >= 0 {
		code := exit.ExitStatus()
		result.ExitCode = &code
		return result, failure("ssh_exit_nonzero", fmt.Sprintf("远端命令退出码为 %d", code))
	}
	return result, failure("ssh_exec_unknown", "SSH 执行中断或未返回退出码，远端状态可能不确定，请检查后再操作")
}
