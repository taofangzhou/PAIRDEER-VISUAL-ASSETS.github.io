#!/usr/bin/env python3
"""Add streamed company uploads to this site's existing nginx configuration.

Keep certificates, server blocks and additional access restrictions intact. This
helper intentionally rejects unfamiliar/nested root locations for manual review.
The caller owns backup, nginx validation, reload and rollback.
"""
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

BEGIN = "# BEGIN PAIRDEER COMPANY MATERIALS"
END = "# END PAIRDEER COMPANY MATERIALS"


def block_end(text, opening):
    depth = 0
    quote = None
    comment = False
    escaped = False
    for index in range(opening, len(text)):
        character = text[index]
        if comment:
            if character == "\n":
                comment = False
            continue
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if quote:
            if character == quote:
                quote = None
            continue
        if character in "\"'":
            quote = character
        elif character == "#":
            comment = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return index + 1
    raise ValueError("nginx 配置括号不完整，未修改文件")


def patch(text):
    # The generated block can be replaced on reruns without touching user rules.
    if text.count(BEGIN) != text.count(END):
        raise ValueError("公司素材配置标记不完整，未修改文件")
    text = re.sub(r"(?m)^[ \t]*" + re.escape(BEGIN) + r"\n[\s\S]*?^[ \t]*" + re.escape(END) + r"\n\n?", "", text)
    if re.search(r"(?m)^\s*location\s+[^\n{]*/api/company-materials/", text):
        # Current repository templates already contain the final configuration.
        if all(directive in text for directive in (
            "client_max_body_size 250m;", "proxy_request_buffering off;",
            "proxy_read_timeout 600s;", "proxy_send_timeout 600s;",
        )):
            return text
        raise ValueError("已存在自定义公司素材 location，请人工核对，未修改文件")

    replacements = []
    for server in re.finditer(r"(?m)^[ \t]*server\s*\{", text):
        opening = text.index("{", server.start())
        ending = block_end(text, opening)
        body = text[opening + 1:ending - 1]
        if not re.search(r"(?m)^\s*server_name\s+[^;]*\bshuanglu-battery\.cn(?=[\s;])", body):
            continue
        for root in re.finditer(r"(?m)^([ \t]*)location\s+/\s*\{", body):
            root_open = body.index("{", root.start())
            root_end = block_end(body, root_open)
            content = body[root_open + 1:root_end - 1]
            if not re.search(r"(?m)^\s*proxy_pass\s+http://127\.0\.0\.1:3000\s*;", content):
                continue
            if re.search(r"(?m)^\s*(?:location|if|limit_except)\b|\{", content):
                raise ValueError("根 location 含嵌套配置，请人工核对，未修改文件")
            # Retain any auth/access directives and extra proxy settings already
            # applied to the site's root location.
            content = re.sub(
                r"(?m)^[ \t]*(?:client_max_body_size|client_body_timeout|proxy_request_buffering|proxy_read_timeout|proxy_send_timeout|proxy_buffering)\s+[^;]*;[^\n]*\n?",
                "", content,
            )
            content = re.sub(
                r"(?m)^[ \t]*proxy_set_header\s+(?:Host|X-Forwarded-Host|X-Forwarded-Proto|X-Real-IP|X-Forwarded-For|CF-Connecting-IP|OAI-Authenticated-User-Id|OAI-Authenticated-User-Email|Connection)\s+[^;]*;[^\n]*\n?",
                "", content, flags=re.I,
            )
            indent = root.group(1)
            inner = indent + "    "
            additions = [
                "client_max_body_size 250m;", "client_body_timeout 600s;",
                "proxy_request_buffering off;", "proxy_read_timeout 600s;",
                "proxy_send_timeout 600s;", "proxy_buffering off;",
                "proxy_set_header Host shuanglu-battery.cn;",
                "proxy_set_header X-Forwarded-Host shuanglu-battery.cn;",
                "proxy_set_header X-Forwarded-Proto $scheme;",
                "proxy_set_header X-Real-IP $remote_addr;",
                "proxy_set_header X-Forwarded-For $remote_addr;",
                'proxy_set_header CF-Connecting-IP "";',
                'proxy_set_header OAI-Authenticated-User-Id "";',
                'proxy_set_header OAI-Authenticated-User-Email "";',
                'proxy_set_header Connection "";',
            ]
            upload = (
                indent + BEGIN + "\n" + indent + "location ^~ /api/company-materials/ {\n"
                + "\n".join(inner + item for item in additions) + "\n"
                + content.strip("\n").rstrip() + "\n" + indent + "}\n"
                + indent + END + "\n\n"
            )
            replacements.append((opening + 1 + root.start(), upload))
    if not replacements:
        raise ValueError("未找到 shuanglu-battery.cn 转发到 127.0.0.1:3000 的标准 location /；未修改文件")
    for position, upload in reversed(replacements):
        text = text[:position] + upload + text[position:]
    return text


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 deploy/patch-company-nginx.py /etc/nginx/conf.d/pairdeer.conf")
    path = Path(sys.argv[1])
    if path.is_symlink() or not path.is_file():
        raise SystemExit("nginx 配置必须是实际普通文件，请先核对符号链接或文件路径")
    original = path.read_text()
    updated = patch(original)
    if original == updated:
        print("公司素材 nginx 配置已就绪，无需更改")
        return
    metadata = path.stat()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".pairdeer-company-", delete=False) as handle:
            temporary = handle.name
            handle.write(updated)
            os.fchmod(handle.fileno(), stat.S_IMODE(metadata.st_mode))
            os.fchown(handle.fileno(), metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            os.unlink(temporary)
    print("已添加公司素材上传配置，等待 nginx -t 校验")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
