# Skills 索引（Agent 能力说明）

> **Skill 是指导，不是权限。** 这里的每个 Skill 都只是给 Agent 的操作说明与边界提醒，
> 不授予读取对话正文、读取/写入凭据、修改 DSH 配置、发布仓库或改变可见性的任何权力。
> 需要 `commit` / `push` / `tag` / `release` / 改安全设置时，仍要维护者逐项明确授权（见根目录 `AGENTS.md`）。

## 什么是 Skill

Skill 是一个可复用的任务说明包：`SKILL.md` 给出触发条件、入口路由与底线，`references/` 放按需读取的细节文档。
它解决“Agent 不知道这个仓库的边界与正确入口”，而不是“给 Agent 开权限”。
安装、使用与排障都以**当前 checkout / 当前版本**为准；文档与实现冲突时以代码与测试为准，并回报文档漂移。

## 现有 Skills

| Skill | 用途 | 触发场景 | 入口 |
| --- | --- | --- | --- |
| `dsh-cockpit` | 安装/更新/解释/排障 DSH 驾驶舱 | 用户问本机 DSH 用量与花费、启动或安装驾驶舱、插件 404、数据为空、金额异常、备份恢复、同步边界 | [skills/dsh-cockpit/SKILL.md](../skills/dsh-cockpit/SKILL.md) |

`dsh-cockpit` 的引用文档：

- [安装与运行](../skills/dsh-cockpit/references/install.md)：独立运行、DSH 插件安装、隔离环境变量、验收清单、更新/卸载。
- [按现象排障](../skills/dsh-cockpit/references/troubleshooting.md)：三条链路、常见现象、插件/端口、源码排查、反馈维护者。

## 目录约定

```
skills/
  <skill-name>/
    SKILL.md              # 必需：YAML frontmatter(name/description) + 正文
    references/           # 可选：按任务读取的细节文档
      install.md
      troubleshooting.md
```

`SKILL.md` 的 frontmatter：

```yaml
---
name: <小写 kebab-case，与目录名一致>
description: <一句话说明“做什么 + 何时用 + 不用于什么”，便于 Agent 路由>
---
```

正文建议包含：先选入口（任务 → 读哪份文档）、红线/底线、最小验证口令、交付标准、参考资料。
细节放 `references/`，`SKILL.md` 保持短，避免一次性灌入大量内容。

## 如何使用

- 支持 Agent Skills 的客户端：把 `skills/dsh-cockpit/` 目录放到该客户端的 skills 目录（或按其文档安装），仅在任务匹配 description 时加载。
- 不自动加载：Skill 不应常驻系统提示，也不应被当作“全权许可”。
- 本仓库内开发时：直接按 `AGENTS.md` 路由读源码；Skill 文档用于面向用户的安装/排障场景。

## 新增 Skill 的检查清单

1. `SKILL.md` 有 `name` / `description` frontmatter，且 description 明确“不用于什么”。
2. 正文包含何时使用/不使用、红线、最小验证、交付标准；细节下沉到 `references/`。
3. 不写真实会话 id/标题/路径/金额/Key；示例一律用合成数据。
4. 不承诺权限：涉及写入用户目录、修改安全设置、发布等，必须写明“需用户/维护者明确授权”。
5. 命令可执行且零额外依赖；引用的文档路径真实存在。
6. 若 Skill 依赖仓库脚本，同时更新本索引与 `docs/TEST-MATRIX.md` 的自动化/人工双栏。
