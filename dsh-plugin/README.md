# dsh-cockpit-plugin

把「DSH 驾驶舱」挂到 DeepSeek Harness Web GUI 的同源子路径 `/dsh-cockpit`。

## 安装

```bash
# 1) 在本仓库根目录之外执行（路径换成你的实际路径）
dsh plugin --profile web add "file:C:/path/to/dsh-cockpit/dsh-plugin"

# 2) 在 ~/.dsh/profiles/web/cordis.patch.yml 追加
#    - insert:
#        - id: dsh-cockpit
#          name: 'dsh-cockpit-plugin'
#    或直接执行：node src/cli.mjs install-plugin --profile web --apply

# 3) 重启 DSH，打开 http://127.0.0.1:<gui端口>/dsh-cockpit
```

也可以完全不装插件：`node src/cli.mjs serve` 在独立端口提供同一页面。

## 卸载

```bash
dsh plugin --profile web remove dsh-cockpit-plugin
# 并从 cordis.patch.yml 删除该 insert 条目
```

## 边界

- 只读：插件不会写入 `~/.dsh`，只读会话文件；
- 无客户端注入：不依赖 DSH 客户端运行时 API；
- 失败可见：源码缺失或渲染异常时返回结构化 JSON 错误，不静默 404。


## 小鲸鱼挂件（融合版）

本插件挂载的服务器同时提供挂件页：

- 独立运行：`http://127.0.0.1:7777/widget.html`
- 在 DSH 内：`/dsh-cockpit/widget.html`（同一套余额/今日已用/峰谷数据，双击可回到驾驶舱页面）

素材来源：MeteorNOX/DeepSeek-Balance-Whale-Widget（经项目所有者确认授权使用）。
