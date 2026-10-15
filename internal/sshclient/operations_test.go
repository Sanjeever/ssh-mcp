package sshclient

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Sanjeever/ssh-mcp/internal/testssh"
)

func testDial(t *testing.T, s *testssh.Server) *Client {
	t.Helper()
	c, err := Dial(context.Background(), testConfig(s), trustPath(t), "accept_new")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}
func TestExecOutputExitStatusAndDrain(t *testing.T) {
	s := testssh.Start(t)
	for _, command := range []string{"ok", "fail", "missing", "large", "invalid"} {
		t.Run(command, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			result, err := testDial(t, s).Exec(ctx, command)
			switch command {
			case "ok":
				if err != nil || result.Stdout != "remote ok\n" || result.Stderr != "remote warning\n" || result.ExitCode == nil || *result.ExitCode != 0 {
					t.Fatalf("%+v %v", result, err)
				}
			case "fail":
				if ErrorCode(err) != "ssh_exit_nonzero" || result.ExitCode == nil || *result.ExitCode != 7 || result.Stdout == "" || result.Stderr == "" {
					t.Fatalf("%+v %v", result, err)
				}
			case "missing":
				if ErrorCode(err) != "ssh_exec_unknown" || result.ExitCode != nil || result.Stdout == "" {
					t.Fatalf("%+v %v", result, err)
				}
			case "large":
				if err != nil || !result.OutputTruncated || len(result.Stdout)+len(result.Stderr) > MaxOutputBytes || !utf8.ValidString(result.Stdout) || result.ExitCode == nil {
					t.Fatalf("截断后未正常完成：len=%d err=%v", len(result.Stdout), err)
				}
			case "invalid":
				if err != nil || !utf8.ValidString(result.Stdout) || !strings.Contains(result.Stdout, "x") {
					t.Fatal(result, err)
				}
			}
		})
	}
}

func TestOperationCancellation(t *testing.T) {
	for _, mode := range []string{"timeout", "cancel", "session"} {
		t.Run(mode, func(t *testing.T) {
			s := testssh.Start(t)
			c := testDial(t, s)
			if mode == "session" {
				s.HangSession.Store(true)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			if mode == "cancel" {
				time.AfterFunc(30*time.Millisecond, cancel)
			}
			start := time.Now()
			result, err := c.Exec(ctx, "hang")
			code := "ssh_timeout"
			if mode == "cancel" {
				code = "ssh_canceled"
			}
			if ErrorCode(err) != code || result.ExitCode != nil || time.Since(start) > 2*time.Second {
				t.Fatalf("%+v %v", result, err)
			}
		})
	}
}

func remoteFile(s *testssh.Server, name string) string {
	p := filepath.ToSlash(filepath.Join(s.Root, name))
	if runtime.GOOS == "windows" {
		p = "/" + p
	}
	return p
}
func TestSFTPRoundtripOverwriteAndTargets(t *testing.T) {
	s := testssh.Start(t)
	c := testDial(t, s)
	ctx := context.Background()
	root := t.TempDir()
	local := filepath.Join(root, "source")
	target := filepath.Join(root, "target")
	remote := remoteFile(s, "payload")
	data := bytes.Repeat([]byte("测试 payload\n"), 10000)
	if err := os.WriteFile(local, data, 0600); err != nil {
		t.Fatal(err)
	}
	if n, err := c.Upload(ctx, local, remote, false); err != nil || n != int64(len(data)) {
		t.Fatal(n, err)
	}
	if _, err := c.Upload(ctx, local, remote, false); ErrorCode(err) != "ssh_target_exists" {
		t.Fatal(err)
	}
	if _, err := c.Upload(ctx, local, remote, true); err != nil {
		t.Fatal(err)
	}
	if n, err := c.Download(ctx, remote, target, false); err != nil || n != int64(len(data)) {
		t.Fatal(n, err)
	}
	actual, _ := os.ReadFile(target)
	if !bytes.Equal(actual, data) {
		t.Fatal("往返内容不一致")
	}
	if _, err := c.Download(ctx, remote, target, false); ErrorCode(err) != "ssh_target_exists" {
		t.Fatal(err)
	}
	if _, err := c.Download(ctx, remoteFile(s, "missing"), target, true); err == nil {
		t.Fatal("不存在文件下载成功")
	}
	actual, _ = os.ReadFile(target)
	if !bytes.Equal(actual, data) {
		t.Fatal("失败下载损坏原目标")
	}
	if _, err := c.Download(ctx, remote, target, true); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Upload(ctx, root, remote, true); ErrorCode(err) != "ssh_transfer_invalid" {
		t.Fatal(err)
	}
	if _, err := c.Upload(ctx, local, remoteFile(s, ""), true); ErrorCode(err) != "ssh_transfer_invalid" {
		t.Fatal(err)
	}
	if _, err := c.Download(ctx, remoteFile(s, ""), target, true); ErrorCode(err) != "ssh_transfer_invalid" {
		t.Fatal(err)
	}
	if _, err := c.Download(ctx, remote, root, true); ErrorCode(err) != "ssh_transfer_invalid" {
		t.Fatal(err)
	}
	if err := os.Symlink(local, filepath.Join(root, "link")); err == nil {
		if _, err := c.Upload(ctx, filepath.Join(root, "link"), remote, true); ErrorCode(err) != "ssh_transfer_invalid" {
			t.Fatal(err)
		}
		if _, err := c.Download(ctx, remote, filepath.Join(root, "link"), true); ErrorCode(err) != "ssh_transfer_invalid" {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(s.Root, "payload"), filepath.Join(s.Root, "link")); err == nil {
		if _, err := c.Upload(ctx, local, remoteFile(s, "link"), true); ErrorCode(err) != "ssh_transfer_invalid" {
			t.Fatal(err)
		}
		if _, err := c.Download(ctx, remoteFile(s, "link"), target, true); ErrorCode(err) != "ssh_transfer_invalid" {
			t.Fatal(err)
		}
	}
	for _, pair := range [][2]string{{"relative", remote}, {local, "relative"}, {local, "~/file"}} {
		if _, err := c.Upload(ctx, pair[0], pair[1], false); ErrorCode(err) != "ssh_path_invalid" {
			t.Fatal(err)
		}
	}
}

func TestTransferSizeAndStreamingLimit(t *testing.T) {
	s := testssh.Start(t)
	c := testDial(t, s)
	large := filepath.Join(t.TempDir(), "large")
	file, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(MaxTransferBytes + 1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if _, err := c.Upload(context.Background(), large, remoteFile(s, "large"), false); ErrorCode(err) != "ssh_transfer_invalid" {
		t.Fatal(err)
	}
	remote := filepath.Join(s.Root, "large")
	file, err = os.Create(remote)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(MaxTransferBytes + 1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if _, err := c.Download(context.Background(), remoteFile(s, "large"), filepath.Join(t.TempDir(), "out"), false); ErrorCode(err) != "ssh_transfer_invalid" {
		t.Fatal(err)
	}
	var out bytes.Buffer
	n, err := copyLimited(&out, strings.NewReader("123456"), 5)
	if n != 5 || ErrorCode(err) != "ssh_transfer_limit" || out.String() != "12345" {
		t.Fatal(n, err, out.String())
	}
}

func TestSFTPCancellationPreservesTarget(t *testing.T) {
	for _, upload := range []bool{false, true} {
		s := testssh.Start(t)
		c := testDial(t, s)
		s.HangSFTP.Store(true)
		target := filepath.Join(t.TempDir(), "original")
		os.WriteFile(target, []byte("原文件"), 0600)
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
		var err error
		if upload {
			_, err = c.Upload(ctx, target, remoteFile(s, "out"), false)
		} else {
			_, err = c.Download(ctx, remoteFile(s, "in"), target, true)
		}
		cancel()
		if ErrorCode(err) != "ssh_timeout" {
			t.Fatal(err)
		}
		actual, _ := os.ReadFile(target)
		if string(actual) != "原文件" {
			t.Fatal("原目标被更改")
		}
		matches, _ := filepath.Glob(filepath.Join(filepath.Dir(target), ".ssh-download-*"))
		if len(matches) != 0 {
			t.Fatal("临时文件未清理")
		}
	}
}

func TestPartialDownloadFailurePreservesOriginal(t *testing.T) {
	s := testssh.Start(t)
	c := testDial(t, s)
	if err := os.WriteFile(filepath.Join(s.Root, "payload"), bytes.Repeat([]byte("x"), 1024*1024), 0600); err != nil {
		t.Fatal(err)
	}
	s.CutSFTP.Store(true)
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("原目标"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	n, err := c.Download(ctx, remoteFile(s, "payload"), target, true)
	if err == nil || n == 0 {
		t.Fatalf("未覆盖部分下载后的失败：bytes=%d err=%v", n, err)
	}
	actual, err := os.ReadFile(target)
	if err != nil || string(actual) != "原目标" {
		t.Fatal("原目标损坏", err)
	}
	matches, err := filepath.Glob(filepath.Join(filepath.Dir(target), ".ssh-download-*"))
	if err != nil || len(matches) != 0 {
		t.Fatal("临时文件未清理", matches, err)
	}
}

func TestConcurrentTransfersDoNotOverwriteByDefault(t *testing.T) {
	s := testssh.Start(t)
	local := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(local, bytes.Repeat([]byte("内容"), 10000), 0600); err != nil {
		t.Fatal(err)
	}
	remote := remoteFile(s, "payload")
	target := filepath.Join(t.TempDir(), "target")
	for _, upload := range []bool{true, false} {
		clients := []*Client{testDial(t, s), testDial(t, s)}
		results := make(chan error, 2)
		var wg sync.WaitGroup
		for _, c := range clients {
			wg.Go(func() {
				var err error
				if upload {
					_, err = c.Upload(context.Background(), local, remote, false)
				} else {
					_, err = c.Download(context.Background(), remote, target, false)
				}
				results <- err
			})
		}
		wg.Wait()
		close(results)
		successes := 0
		for err := range results {
			if err == nil {
				successes++
			}
		}
		if successes != 1 {
			t.Fatalf("默认禁止覆盖时成功次数应为 1，实际 %d", successes)
		}
	}
}
