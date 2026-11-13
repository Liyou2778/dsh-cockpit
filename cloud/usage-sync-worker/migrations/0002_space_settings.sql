-- DSH 驾驶舱 · 团队共享同步：0002 空间设置（共享计划）
--
-- 设计：
--   * settings 为聚合 JSON（当前只含 plan），不含任何会话/标题/路径；
--   * 由 owner 通过 PUT /v1/space/settings 修改，成员只读；
--   * 老库执行本迁移即可，代码对空 settings 容错（默认 `{}`）。

ALTER TABLE spaces ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
