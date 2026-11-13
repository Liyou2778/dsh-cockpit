# 贡献指南

1. 先开 issue 说明场景/复现步骤，再提 PR；
2. 提交前必须通过：`node --test "test/*.test.mjs"`、`node scripts/lint.mjs`、`npx playwright test`；
3. 新增核心逻辑需要配 `node:test` 用例；
4. 不提交真实会话数据/密钥/本机路径（`node scripts/audit-public.mjs` 自检）；
5. 美术素材请注明来源与许可，禁止提交无授权素材。
