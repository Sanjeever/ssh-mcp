package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Sanjeever/ssh-mcp/internal/config"
	"github.com/Sanjeever/ssh-mcp/internal/tools"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var version = "dev"

func run() error {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Fprintln(os.Stdout, version)
		return nil
	}
	if len(os.Args) != 1 {
		return errors.New("用法：ssh-mcp 或 ssh-mcp --version")
	}
	cfg, err := config.Load(os.Environ())
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err = tools.NewServer(ctx, cfg, version).Run(ctx, &mcp.StdioTransport{})
	if errors.Is(err, context.Canceled) {
		return nil
	}
	if err != nil {
		return errors.New("MCP stdio 会话异常结束")
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
