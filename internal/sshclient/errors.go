package sshclient

import (
	"context"
	"errors"
)

type Error struct{ Code, Message string }

func (e *Error) Error() string           { return e.Message }
func failure(code, message string) error { return &Error{code, message} }
func ErrorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	if err != nil {
		return "ssh_error"
	}
	return ""
}

func interrupted(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return failure("ssh_timeout", "SSH 操作超时；远端进程或文件状态可能不确定，关闭连接不保证远端进程已停止，请检查后再操作")
	}
	return failure("ssh_canceled", "SSH 操作已取消；远端进程或文件状态可能不确定，上传可能遗留部分文件，请检查后再操作")
}
