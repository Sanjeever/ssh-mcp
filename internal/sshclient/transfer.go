package sshclient

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/pkg/sftp"
)

func ValidatePaths(local, remote string) error {
	if !filepath.IsAbs(local) || strings.ContainsRune(local, 0) {
		return failure("ssh_path_invalid", "local_path 必须是 MCP 进程所在机器的绝对路径")
	}
	if !path.IsAbs(remote) || strings.ContainsRune(remote, 0) {
		return failure("ssh_path_invalid", "remote_path 必须是远端 SFTP 绝对路径，不展开 ~ 或环境变量")
	}
	return nil
}
func (c *Client) transferError(ctx context.Context, message string) error {
	if ctx.Err() != nil {
		return interrupted(ctx)
	}
	return failure("ssh_transfer_failed", message)
}

func (c *Client) Upload(ctx context.Context, local, remote string, overwrite bool) (int64, error) {
	if err := ValidatePaths(local, remote); err != nil {
		return 0, err
	}
	stop := context.AfterFunc(ctx, func() { _ = c.Client.Close() })
	defer stop()
	if ctx.Err() != nil {
		return 0, interrupted(ctx)
	}
	info, err := os.Lstat(local)
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxTransferBytes {
		return 0, failure("ssh_transfer_invalid", "上传源必须是可访问的单个普通文件，不能是符号链接，且不超过 128 MiB")
	}
	source, err := os.Open(local)
	if err != nil {
		return 0, failure("ssh_transfer_failed", "无法打开本地上传源")
	}
	defer source.Close()
	info, err = source.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > MaxTransferBytes {
		return 0, failure("ssh_transfer_invalid", "上传源不是普通文件或超过 128 MiB")
	}
	files, err := sftp.NewClient(c.Client)
	if err != nil {
		return 0, c.transferError(ctx, "远端无法建立 SFTP 子系统")
	}
	defer files.Close()
	if existing, err := files.Lstat(remote); err == nil {
		if !existing.Mode().IsRegular() {
			return 0, failure("ssh_transfer_invalid", "远端目标不能是目录或符号链接")
		}
		if !overwrite {
			return 0, failure("ssh_target_exists", "远端目标已存在，覆盖需要 overwrite=true")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, c.transferError(ctx, "无法检查远端目标")
	}
	flags := os.O_WRONLY | os.O_CREATE
	if overwrite {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_EXCL
	}
	target, err := files.OpenFile(remote, flags)
	if err != nil {
		return 0, c.transferError(ctx, "无法创建远端文件；默认禁止覆盖，父目录必须存在")
	}
	count, copyErr := copyLimited(target, source, MaxTransferBytes)
	closeErr := target.Close()
	sourceErr := source.Close()
	if ctx.Err() == nil && ErrorCode(copyErr) == "ssh_transfer_limit" {
		return count, failure("ssh_transfer_limit", "上传源在传输中超过 128 MiB 上限，远端可能遗留部分文件")
	}
	if ctx.Err() != nil || copyErr != nil || closeErr != nil || sourceErr != nil {
		return count, c.transferError(ctx, "SFTP 上传未完成，远端可能遗留部分文件，请检查后再操作")
	}
	return count, nil
}

func checkLocalTarget(local string, overwrite bool) error {
	info, err := os.Lstat(local)
	if err == nil {
		if !info.Mode().IsRegular() {
			return failure("ssh_transfer_invalid", "本地目标不能是目录或符号链接")
		}
		if !overwrite {
			return failure("ssh_target_exists", "本地目标已存在，覆盖需要 overwrite=true")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return failure("ssh_transfer_failed", "无法检查本地目标")
	}
	return nil
}

func (c *Client) Download(ctx context.Context, remote, local string, overwrite bool) (int64, error) {
	if err := ValidatePaths(local, remote); err != nil {
		return 0, err
	}
	stop := context.AfterFunc(ctx, func() { _ = c.Client.Close() })
	defer stop()
	if ctx.Err() != nil {
		return 0, interrupted(ctx)
	}
	if err := checkLocalTarget(local, overwrite); err != nil {
		return 0, err
	}
	files, err := sftp.NewClient(c.Client)
	if err != nil {
		return 0, c.transferError(ctx, "远端无法建立 SFTP 子系统")
	}
	defer files.Close()
	info, err := files.Lstat(remote)
	if err != nil {
		return 0, c.transferError(ctx, "无法读取远端文件信息")
	}
	if !info.Mode().IsRegular() || info.Size() > MaxTransferBytes {
		return 0, failure("ssh_transfer_invalid", "下载源必须是单个普通文件，不能是符号链接，且不超过 128 MiB")
	}
	source, err := files.Open(remote)
	if err != nil {
		return 0, c.transferError(ctx, "无法打开远端文件")
	}
	defer source.Close()
	target, err := os.CreateTemp(filepath.Dir(local), ".ssh-download-*")
	if err != nil {
		return 0, failure("ssh_transfer_failed", "无法创建本地临时文件，父目录必须存在且可写")
	}
	temp := target.Name()
	defer os.Remove(temp)
	count, copyErr := copyLimited(target, source, MaxTransferBytes)
	sourceErr := source.Close()
	syncErr := target.Sync()
	closeErr := target.Close()
	if ctx.Err() == nil && ErrorCode(copyErr) == "ssh_transfer_limit" {
		return count, failure("ssh_transfer_limit", "下载源在传输中超过 128 MiB 上限，原目标文件未替换")
	}
	if ctx.Err() != nil || copyErr != nil || sourceErr != nil || syncErr != nil || closeErr != nil {
		return count, c.transferError(ctx, "SFTP 下载未完成，原目标文件未替换")
	}
	if err := checkLocalTarget(local, overwrite); err != nil {
		return count, err
	}
	if ctx.Err() != nil {
		return count, interrupted(ctx)
	}
	// 同目录硬链接以排他方式发布，Windows NTFS 同样支持；不支持时明确失败。
	// 覆盖使用系统重命名，Windows Go 实现使用 MoveFileEx(REPLACE_EXISTING)。
	if overwrite {
		err = os.Rename(temp, local)
	} else {
		err = os.Link(temp, local)
	}
	if err != nil {
		return count, failure("ssh_transfer_failed", "下载完成但无法发布目标文件，原目标未替换；请检查权限、目标冲突和文件系统支持")
	}
	return count, nil
}

func copyLimited(dst io.Writer, src io.Reader, limit int64) (int64, error) {
	count, err := io.Copy(dst, io.LimitReader(src, limit))
	if err != nil {
		return count, err
	}
	var extra [1]byte
	n, err := io.ReadFull(src, extra[:])
	if n > 0 {
		return count, failure("ssh_transfer_limit", "文件在传输中超过 128 MiB 上限")
	}
	if err != nil && err != io.EOF {
		return count, err
	}
	return count, nil
}
