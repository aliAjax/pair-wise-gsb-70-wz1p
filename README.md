# API 契约兼容性审查与版本发布平台

用于后端维护者、接口评审人和调用方负责人协作处理 API 契约变化的独立前端工程。工程没有真实后端，首次运行加载本地模拟契约，后续状态写入浏览器 `localStorage`。

## 技术栈

- React 19 + TypeScript + Vite 8
- shadcn/ui 风格本地组件 + Radix UI primitives
- Zustand + persist
- TanStack Router
- TanStack Query
- Monaco Editor / Diff Editor
- Tailwind CSS 4

## 功能

- OpenAPI JSON 导入、契约列表搜索和领域/状态筛选
- 字段新增、删除、可选性、枚举与错误码变化展示
- 自动判定兼容、警告或不兼容，并要求调用方影响说明与迁移方案
- Monaco Editor 编辑契约定义，Monaco Diff Editor 比较正式版本快照
- 调用方列表、示例请求生成、逐条接受、退回和兼容层豁免
- 跨契约批量评审、发布门禁、正式版本冻结与版本历史
- 发布窗口：把契约版本、差异范围和调用方接成按调用方分批放行
  - 开窗冻结参与契约、差异范围与差异签名，窗口修订号从 r1 起
  - 冻结范围内某份契约差异一改：修订号 +1，仅作废依赖该契约且未放行的调用方，已放行的保留依据
  - 验收回执带窗口修订号与客户端版本；重复回执只计一次，修订号缺失（旧回执）或对不上先待核，不挡住同批其他调用方
  - 两个窗口同时提交同一调用方时只放先到者，后者只待核、不生成放行记录
  - 保存失败后从完整窗口快照恢复未完成项，重放按操作号幂等，不生成第二份放行记录
  - 发布页、契约详情、变更报告显示同一份窗口结果
- Markdown 变更报告（含窗口放行结果）与 JSON 导出

## 行为测试

纯函数领域规则与服务层（localStorage 垫片、故障/恢复）各有一套脚本：

```bash
node --import jiti/register scripts/window-behavior.test.ts
node --import jiti/register scripts/window-service.test.ts
```

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18470`。

生产构建：

```bash
npm run build
```

构建输出位于 `dist`。

## 目录

```text
src/
  components/             shadcn/Radix 基础组件、业务组件、应用外壳
  data/                   本地模拟契约
  lib/                    通用工具
  models/                 契约模型、兼容性与发布门禁规则
  pages/                  工作台、详情、批量评审、发布、报告
  services/               本地持久化服务和 TanStack Query hooks
  store/                  Zustand 评审工作区状态
```
