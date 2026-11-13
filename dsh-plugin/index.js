/**
 * DSH Cordis 插件入口（PRD FR-10）。
 *
 * 只做三件事：
 *   1) 声明依赖的服务（webServer）；
 *   2) 把 `src/server.mjs` 的请求处理器挂到 `/dsh-cockpit` 前缀；
 *   3) 用 ctx.effect 管理生命周期（模块卸载即注销路由）。
 *
 * 设计约束：
 *   - 薄封装（≤60 行），不复制业务逻辑 —— CLI / Web / 插件共享同一 core；
 *   - 不注册客户端注入，避免依赖 rc 阶段的客户端 API（PRD R2）；
 *   - 源码缺失时给出可操作错误，而不是静默 404。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const name = "dsh-cockpit";
export const inject = ["webServer"];

const MOUNT_PATH = "/dsh-cockpit";

async function loadHandler() {
  const entry = new URL("../src/server.mjs", import.meta.url);
  if (!existsSync(fileURLToPath(entry))) {
    throw new Error(
      "dsh-cockpit 源码缺失：请把本插件作为 dsh-cockpit 仓库的 file: 依赖安装（见仓库 README 安装章节）",
    );
  }
  const { createRequestHandler } = await import(entry.href);
  return createRequestHandler({ mountBase: MOUNT_PATH });
}

export function apply(ctx) {
  const ready = loadHandler();
  const handler = async (req, res) => {
    try {
      const inner = await ready;
      await inner(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: { code: "COCKPIT_PLUGIN_FAILED", message: String(error?.message ?? error) } }));
      } else {
        res.end();
      }
    }
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: MOUNT_PATH,
        handler,
      }),
    "dsh-cockpit: dashboard + api",
  );
}
