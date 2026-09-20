/**
 * 桌宠场景桩：PetStage 依赖 vite 的 import.meta.glob 资源管线，jsdom 冒烟环境没有。
 * 草稿/目录集成回归只覆盖主界面（<App/>），pet 场景以空组件替身保住模块图完整。
 */
export function PetStage() { return null }
export function PetSettingsPage() { return null }
