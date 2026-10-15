package tools

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/Sanjeever/ssh-mcp/internal/config"
	"github.com/Sanjeever/ssh-mcp/internal/sshclient"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type ToolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type ServerInfo struct {
	ServerID    string `json:"server_id"`
	Description string `json:"description"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	AuthType    string `json:"auth_type"`
}
type ListResult struct {
	Servers []ServerInfo `json:"servers"`
}
type ExecInput struct {
	ServerID       string `json:"server_id"`
	Command        string `json:"command"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
}
type TransferInput struct {
	ServerID       string `json:"server_id"`
	LocalPath      string `json:"local_path"`
	RemotePath     string `json:"remote_path"`
	Overwrite      bool   `json:"overwrite,omitempty"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
}
type ExecResult struct {
	ServerID string `json:"server_id"`
	sshclient.ExecResult
	DurationMS int64      `json:"duration_ms"`
	Error      *ToolError `json:"error,omitempty"`
}
type TransferResult struct {
	ServerID         string     `json:"server_id"`
	LocalPath        string     `json:"local_path"`
	RemotePath       string     `json:"remote_path"`
	BytesTransferred int64      `json:"bytes_transferred"`
	DurationMS       int64      `json:"duration_ms"`
	Error            *ToolError `json:"error,omitempty"`
}

func inputSchema(transfer bool) *jsonschema.Schema {
	minimum, maximum := float64(1), float64(3600)
	properties := map[string]*jsonschema.Schema{
		"server_id":       {Type: "string", Pattern: `^[a-z][a-z0-9_]*$`, Description: "ssh_list 返回的精确 server_id，不自动选择目标"},
		"timeout_seconds": {Type: "integer", Minimum: &minimum, Maximum: &maximum, Default: json.RawMessage("180"), Description: "调用总超时秒数，连接与认证另设 15 秒上限"},
	}
	required := []string{"server_id"}
	if transfer {
		properties["local_path"] = &jsonschema.Schema{Type: "string", MinLength: jsonschema.Ptr(1), Description: "MCP 进程所在机器的绝对文件路径，父目录须存在"}
		properties["remote_path"] = &jsonschema.Schema{Type: "string", Pattern: `^/`, Description: "远端 SFTP 绝对文件路径，不展开 ~ 或环境变量，父目录须存在"}
		properties["overwrite"] = &jsonschema.Schema{Type: "boolean", Default: json.RawMessage("false")}
		required = append(required, "local_path", "remote_path")
	} else {
		properties["command"] = &jsonschema.Schema{Type: "string", MinLength: jsonschema.Ptr(1), Description: "交给远端默认 Shell 解释，不经过本机 Shell"}
		required = append(required, "command")
	}
	return &jsonschema.Schema{Type: "object", Properties: properties, Required: required, AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}}}
}

func resultError(err error) (*mcp.CallToolResult, *ToolError) {
	if err == nil {
		return nil, nil
	}
	return &mcp.CallToolResult{IsError: true}, &ToolError{Code: sshclient.ErrorCode(err), Message: err.Error()}
}

func NewServer(root context.Context, cfg config.Config, version string) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "ssh-mcp", Version: version}, nil)
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			callCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			stop := context.AfterFunc(root, cancel)
			defer stop()
			if root.Err() != nil {
				cancel()
			}
			result, err := next(callCtx, method, req)
			// SDK 负责 Schema 校验；将校验失败转成中文且不回显参数值。
			if method == "tools/call" {
				if res, ok := result.(*mcp.CallToolResult); ok && res.IsError && res.StructuredContent == nil {
					res.Content = []mcp.Content{&mcp.TextContent{Text: "工具参数无效，请按输入 Schema 检查必填字段、类型、取值范围和未知参数"}}
				}
			}
			return result, err
		}
	})
	mcp.AddTool(server, &mcp.Tool{Name: "ssh_list", Description: "列出配置中的 SSH 服务器与认证类型，按 server_id 排序，不联网探测，不返回凭据。远端操作前使用精确 server_id 选择目标。", InputSchema: &jsonschema.Schema{Type: "object", Properties: map[string]*jsonschema.Schema{}, AdditionalProperties: &jsonschema.Schema{Not: &jsonschema.Schema{}}}}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, ListResult, error) {
		out := ListResult{Servers: make([]ServerInfo, 0, len(cfg.Servers))}
		for _, s := range cfg.Servers {
			out.Servers = append(out.Servers, ServerInfo{s.ID, s.Description, s.Host, s.Port, s.Username, s.AuthType()})
		}
		sort.Slice(out.Servers, func(i, j int) bool { return out.Servers[i].ServerID < out.Servers[j].ServerID })
		return nil, out, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "ssh_exec", Description: "通过独立 SSH exec 执行远端命令，无 PTY、无持续 Shell、不自动输入 sudo 密码。stdout/stderr 合计保留 128 KiB，超出后排空。超时或取消后远端状态可能不确定，不自动重试。", InputSchema: inputSchema(false)}, func(ctx context.Context, _ *mcp.CallToolRequest, in ExecInput) (*mcp.CallToolResult, ExecResult, error) {
		start := time.Now()
		out := ExecResult{ServerID: in.ServerID}
		ctx, cancel := operationContext(ctx, in.TimeoutSeconds)
		defer cancel()
		client, err := dial(ctx, cfg, in.ServerID)
		if err == nil {
			defer client.Close()
			out.ExecResult, err = client.Exec(ctx, in.Command)
		}
		out.DurationMS = time.Since(start).Milliseconds()
		res, toolErr := resultError(err)
		out.Error = toolErr
		return res, out, nil
	})
	for _, name := range []string{"ssh_upload", "ssh_download"} {
		description := "通过 SFTP 传输单个普通文件，最大 128 MiB，默认禁止覆盖，不创建父目录。local_path 使用本机绝对路径，remote_path 使用远端绝对路径，不展开 ~。"
		if name == "ssh_upload" {
			description += "上传失败可能遗留远端部分文件。"
		} else {
			description += "下载先写同目录临时文件，完整完成后发布，失败保留原目标。"
		}
		mcp.AddTool(server, &mcp.Tool{Name: name, Description: description, InputSchema: inputSchema(true)}, func(ctx context.Context, _ *mcp.CallToolRequest, in TransferInput) (*mcp.CallToolResult, TransferResult, error) {
			start := time.Now()
			out := TransferResult{ServerID: in.ServerID, LocalPath: in.LocalPath, RemotePath: in.RemotePath}
			ctx, cancel := operationContext(ctx, in.TimeoutSeconds)
			defer cancel()
			err := sshclient.ValidatePaths(in.LocalPath, in.RemotePath)
			if err == nil {
				var client *sshclient.Client
				client, err = dial(ctx, cfg, in.ServerID)
				if err == nil {
					defer client.Close()
					if name == "ssh_upload" {
						out.BytesTransferred, err = client.Upload(ctx, in.LocalPath, in.RemotePath, in.Overwrite)
					} else {
						out.BytesTransferred, err = client.Download(ctx, in.RemotePath, in.LocalPath, in.Overwrite)
					}
				}
			}
			out.DurationMS = time.Since(start).Milliseconds()
			res, toolErr := resultError(err)
			out.Error = toolErr
			return res, out, nil
		})
	}
	return server
}

func operationContext(ctx context.Context, seconds int) (context.Context, context.CancelFunc) {
	if seconds == 0 {
		seconds = sshclient.DefaultTimeoutSeconds
	}
	return context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
}
func dial(ctx context.Context, cfg config.Config, id string) (*sshclient.Client, error) {
	s, ok := cfg.Servers[id]
	if !ok {
		return nil, &sshclient.Error{Code: "ssh_server_unknown", Message: "未知 server_id，请使用 ssh_list 返回的精确 ID"}
	}
	return sshclient.Dial(ctx, s, cfg.KnownHosts, cfg.HostKeyPolicy)
}
