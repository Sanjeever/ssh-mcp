package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Sanjeever/ssh-mcp/internal/testssh"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func buildBinary(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "ssh-mcp")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	cmd := exec.Command("go", "build", "-ldflags", "-X main.version=0.1.0-test", "-o", binary, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("构建失败：%v %s", err, out)
	}
	return binary
}
func cleanEnv() []string {
	var env []string
	for _, v := range os.Environ() {
		if !strings.HasPrefix(v, "SSH_MCP_") {
			env = append(env, v)
		}
	}
	return env
}

type process struct {
	session *mcp.ClientSession
	stdin   io.WriteCloser
	cmd     *exec.Cmd
	done    chan error
	stderr  *bytes.Buffer
}

func startProcess(t *testing.T, binary string, s *testssh.Server) *process {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, binary)
	cmd.Env = append(cleanEnv(), "SSH_MCP_SERVER_TEST_HOST="+s.Host, "SSH_MCP_SERVER_TEST_PORT="+fmtInt(s.Port), "SSH_MCP_SERVER_TEST_USERNAME=operator", "SSH_MCP_SERVER_TEST_PASSWORD= secret ", "SSH_MCP_KNOWN_HOSTS="+filepath.Join(t.TempDir(), "known_hosts"))
	cmd.Env = append(cmd.Env, "SSH_MCP_SERVER_Z_HOST=192.0.2.2", "SSH_MCP_SERVER_Z_USERNAME=test", "SSH_MCP_SERVER_Z_PASSWORD=测试密码", "SSH_MCP_SERVER_A_HOST=192.0.2.1", "SSH_MCP_SERVER_A_USERNAME=test", "SSH_MCP_SERVER_A_PASSWORD=测试密码")
	stderr := new(bytes.Buffer)
	cmd.Stderr = stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcp.IOTransport{Reader: stdout, Writer: stdin}, nil)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		t.Fatal(err, stderr.String())
	}
	p := &process{session: session, stdin: stdin, cmd: cmd, done: make(chan error, 1), stderr: stderr}
	go func() { p.done <- cmd.Wait() }()
	t.Cleanup(func() { session.Close(); cmd.Process.Kill() })
	return p
}
func fmtInt(value int) string { return strconv.Itoa(value) }
func call(t *testing.T, p *process, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := p.session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	return res
}
func object(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestStdioToolsAndSchemas(t *testing.T) {
	s := testssh.Start(t)
	p := startProcess(t, buildBinary(t), s)
	listed, err := p.session.ListTools(context.Background(), nil)
	if err != nil || len(listed.Tools) != 4 {
		t.Fatal(listed, err)
	}
	schemas := map[string]*jsonschema.Resolved{}
	for _, tool := range listed.Tools {
		raw, _ := json.Marshal(tool.OutputSchema)
		var schema jsonschema.Schema
		if err := json.Unmarshal(raw, &schema); err != nil {
			t.Fatal(err)
		}
		resolved, err := schema.Resolve(nil)
		if err != nil {
			t.Fatal(err)
		}
		schemas[tool.Name] = resolved
	}
	list := call(t, p, "ssh_list", map[string]any{})
	if list.IsError || s.AuthCount.Load() != 0 {
		t.Fatal("列出服务器触发联网")
	}
	servers := object(t, list.StructuredContent)["servers"].([]any)
	if len(servers) != 3 || servers[0].(map[string]any)["server_id"] != "a" || servers[1].(map[string]any)["server_id"] != "test" || servers[2].(map[string]any)["server_id"] != "z" {
		t.Fatal("列表未稳定排序", servers)
	}
	raw, _ := json.Marshal(list)
	if strings.Contains(string(raw), " secret ") || strings.Contains(string(raw), "private_key_path") {
		t.Fatal("凭据泄露")
	}
	for _, command := range []string{"ok", "fail", "missing", "signal", "large"} {
		res := call(t, p, "ssh_exec", map[string]any{"server_id": "test", "command": command})
		obj := object(t, res.StructuredContent)
		if err := schemas["ssh_exec"].Validate(obj); err != nil {
			t.Fatal("输出 Schema 不匹配", err, obj)
		}
		if res.IsError != (command == "fail" || command == "missing" || command == "signal") {
			t.Fatal(command, res)
		}
		if (command == "missing" || command == "signal") && obj["exit_code"] != nil {
			t.Fatal("伪造退出码")
		}
		if len(res.Content) == 0 {
			t.Fatal("缺少文本结果")
		}
	}
	for _, args := range []map[string]any{{"server_id": "test", "command": "ok", "extra": "secret"}, {"server_id": "test", "command": "ok", "timeout_seconds": 0}, {"server_id": "test", "command": "ok", "timeout_seconds": 3601}, {"server_id": "test", "command": "ok", "timeout_seconds": 1.5}, {"command": "ok"}, {"server_id": "TEST", "command": "ok"}} {
		res := call(t, p, "ssh_exec", args)
		if !res.IsError {
			t.Fatal("接受非法参数", args)
		}
		raw, _ := json.Marshal(res)
		if strings.Contains(string(raw), "secret") {
			t.Fatal("校验错误回显参数")
		}
	}
	if !call(t, p, "ssh_list", map[string]any{"extra": true}).IsError {
		t.Fatal("ssh_list 接受未知参数")
	}
	unknown := call(t, p, "ssh_exec", map[string]any{"server_id": "unknown", "command": "ok"})
	if !unknown.IsError || object(t, unknown.StructuredContent)["exit_code"] != nil {
		t.Fatal(unknown)
	}
	root := t.TempDir()
	local := filepath.Join(root, "source")
	target := filepath.Join(root, "target")
	os.WriteFile(local, []byte("MCP 文件传输"), 0600)
	remote := filepath.ToSlash(filepath.Join(s.Root, "payload"))
	if runtime.GOOS == "windows" {
		remote = "/" + remote
	}
	for _, name := range []string{"ssh_upload", "ssh_download"} {
		path := local
		if name == "ssh_download" {
			path = target
		}
		args := map[string]any{"server_id": "test", "local_path": path, "remote_path": remote}
		res := call(t, p, name, args)
		if res.IsError {
			t.Fatal(res)
		}
		if err := schemas[name].Validate(object(t, res.StructuredContent)); err != nil {
			t.Fatal(err)
		}
		res = call(t, p, name, args)
		if !res.IsError {
			t.Fatal("未禁止覆盖")
		}
		if err := schemas[name].Validate(object(t, res.StructuredContent)); err != nil {
			t.Fatal("失败结果 Schema 不匹配", err)
		}
	}
	data, _ := os.ReadFile(target)
	if string(data) != "MCP 文件传输" {
		t.Fatal("MCP 往返内容错误")
	}
	p.stdin.Close()
	select {
	case err := <-p.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("EOF 未退出")
	}
	if p.stderr.Len() != 0 {
		t.Fatal("正常运行产生诊断日志", p.stderr.String())
	}
}

func TestStdioCancellationEOFAndSignal(t *testing.T) {
	binary := buildBinary(t)
	for _, mode := range []string{"cancel", "eof", "signal"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "signal" && runtime.GOOS == "windows" {
				t.Skip("Windows 不支持 POSIX SIGTERM，EOF 和 MCP 取消另有测试")
			}
			s := testssh.Start(t)
			p := startProcess(t, binary, s)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			go func() {
				defer close(done)
				p.session.CallTool(ctx, &mcp.CallToolParams{Name: "ssh_exec", Arguments: map[string]any{"server_id": "test", "command": "hang"}})
			}()
			deadline := time.Now().Add(2 * time.Second)
			for s.AuthCount.Load() == 0 && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if s.AuthCount.Load() == 0 {
				t.Fatal("工具未连接测试服务")
			}
			switch mode {
			case "cancel":
				cancel()
			case "eof":
				p.stdin.Close()
			case "signal":
				p.cmd.Process.Signal(syscall.SIGTERM)
			}
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("调用未结束")
			}
			if mode == "cancel" {
				p.stdin.Close()
			}
			select {
			case err := <-p.done:
				if err != nil {
					t.Fatal(err, p.stderr.String())
				}
			case <-time.After(3 * time.Second):
				t.Fatal("进程未退出")
			}
		})
	}
}

func TestVersionAndStartupErrors(t *testing.T) {
	binary := buildBinary(t)
	cmd := exec.Command(binary, "--version")
	cmd.Env = cleanEnv()
	out, err := cmd.Output()
	if err != nil || string(out) != "0.1.0-test\n" {
		t.Fatal(string(out), err)
	}
	cmd = exec.Command(binary)
	cmd.Env = cleanEnv()
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err == nil || stdout.Len() != 0 || !strings.Contains(stderr.String(), "至少") {
		t.Fatal(err, stdout.String(), stderr.String())
	}
}
