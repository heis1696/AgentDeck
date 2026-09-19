// 提示词集中地统一入口：业务模块一律 `import { … } from './prompts'`（或 './prompts/xxx' 直取单域）。
// 约束：本目录只放纯文案与纯模板函数，不 import electron、不放解析器与业务逻辑，
// 便于统一审阅、全局搜索与后续调优。新增提示词请归入对应域文件，新域文件在此汇总导出。
export * from './delegation'
export * from './handoff'
export * from './meeting'
export * from './goal'
export * from './forge'
export * from './personas'
