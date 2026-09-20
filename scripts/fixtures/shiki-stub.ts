/**
 * shiki 桩（仅测试用）：真实高亮器要加载 wasm/语言包，焦点回归不需要它。
 * smoke-ui-focus.mjs 用 esbuild 插件把所有 `shiki*` 解析到这里。
 */
export const createHighlighterCore = async () => ({
  loadLanguage: async () => {},
  codeToTokens: (text: string) => ({ tokens: text.split('\n').map((line) => [{ content: line, offset: 0 }]) })
})
export const createOnigurumaEngine = () => ({})
export default { name: 'stub' }
