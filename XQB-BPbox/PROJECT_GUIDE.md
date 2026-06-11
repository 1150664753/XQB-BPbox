# PROJECT_GUIDE

本项目是 Electron + React + TypeScript 的 BP 工具，数据和配置通过项目根目录下的本地文件系统读写。本文用于快速定位代码，减少重复扫描。

## 顶层目录

- `src/main/`：Electron 主进程代码，包含窗口、协议、本地文件存储、IPC。
- `src/preload/`：预加载脚本和暴露给渲染进程的 `window.bpAPI` 类型/桥接定义。
- `src/renderer/src/`：React 渲染进程代码，控制台、展示页、预览页都在这里。
- `src/shared/`：主进程和渲染进程共用的数据类型，目前核心是 `types.ts`。
- `assets/`：项目资源。`assets/icons/` 存放 Activity Bar 图标：`icon-role.png`、`icon-lightcone.png`、`icon-flow.png`、`icon-ui.png`、`icon-bp.png`。
- `config/`：项目配置。展示页配置在 `config/display/`，BP 流程配置在 `config/bp/`，音频轴配置在 `config/audio/`，应用配置在 `config/app/` 和 `config/settings.json`。
- `results/`：运行和导出结果。BP 结果存放在 `results/bp/`。
- `resources/`：应用打包图标等 Electron 资源。
- `build/`、`out/`、`node_modules/`：构建产物或依赖，不建议手动修改。

## 关键入口

- Electron 主进程入口：`src/main/index.ts`。
- 窗口创建与管理：`src/main/windows.ts`。
- 自定义资源协议/文件访问：`src/main/protocols.ts`。
- 渲染进程入口：`src/renderer/src/main.tsx`，这里导入全局 CSS 并挂载 React。
- 前端路由入口：`src/renderer/src/App.tsx`。根据 hash 切换：
  - 默认控制台：`ConsolePage`
  - 展示页：`#/display` -> `DisplayPage`
  - 预览页：`#/preview` -> `PreviewPage`

## 页面与展示组件

- `src/renderer/src/pages/ConsolePage.tsx`：控制台主页面，含角色管理、光锥管理、流程配置、展示页设置、开始 BP。文件较大，先用 `rg` 定位组件。
- `src/renderer/src/pages/DisplayPage.tsx`：正式展示页，接收 BP 状态、播放音效/唱名视频。
- `src/renderer/src/pages/PreviewPage.tsx`：预览页面，用于展示设置预览。
- `src/renderer/src/components/display/DisplayCanvas.tsx`：展示页核心画布，整合背景、队伍面板、槽位特效、唱名视频。
- `src/renderer/src/components/display/`：展示页子组件，含背景、队伍、Pick/Ban 槽位和坐标缩放。

## 展示页设置相关

展示页设置 UI 主要在 `ConsolePage.tsx` 内：`DisplaySettingsPanel` 是主组件，`SlotEffectEditor` 管特效音效，`VideoSlotEditor` 管唱名视频槽，`SlotLayoutEditor` 管槽位，`PageChangeCard` 管页面变化。

样式分布：

- `src/renderer/src/styles/vscode-light.css`：历史全局样式和基础组件样式。
- `src/renderer/src/styles/light-workbench.css`：浅色 VSCode 工作台外壳样式，包括 Activity Bar、Side Bar、Editor Tab、Status Bar。
- `src/renderer/src/styles/display-settings.css`：展示页设置三列布局、panel、Inspector、滚动条样式。

## 文件与配置读写

- `src/main/assets.ts`：项目根路径、`config`/`assets`/`results` 目录初始化、资源路径归一化、本地资源扫描。
- `src/main/stores/characters.ts`、`lightCones.ts`：角色/光锥配置文件读写，存放在 `config/app/`。
- `src/main/ipc/flows.ts`：BP 流程文件读取、保存、导入，存放在 `config/bp/`。
- `src/main/ipc/displaySettings.ts`：展示页设置读取、保存、live update、素材路径归一化，存放在 `config/display/`。
- `src/main/ipc/voiceTimelines.ts`：音频轴、配音和时间线配置读写，存放在 `config/audio/`。
- `src/main/ipc/bp.ts`：BP 状态、展示窗口、预览窗口、结果保存 IPC，结果存放在 `results/bp/`。
- `src/main/ipc/assets.ts`：选择本地资源、转换资源 URL、扫描 `assets/` 文件夹。

## 常见任务定位

- 修改展示页设置 UI：看 `ConsolePage.tsx` 的 `DisplaySettingsPanel`、`SlotEffectEditor`、`VideoSlotEditor`，再看 `display-settings.css`、`light-workbench.css`。
- 修改左侧导航栏：看 `ConsolePage.tsx` 顶部 `navItems` 和 Activity Bar/Side Bar 渲染，再看 `light-workbench.css`。
- 修改图标资源：替换 `assets/icons/` 中对应 PNG；新增导航项时更新 `navItems`。
- 修改保存展示设置逻辑：看 `src/main/ipc/displaySettings.ts`，再看 `DisplaySettingsPanel` 的 `saveSettings`、`updateLive`。
- 修改预览页面：看 `PreviewPage.tsx`、`DisplayCanvas.tsx`、`src/main/ipc/bp.ts`。
- 修改正式展示效果：看 `DisplayPage.tsx` 和 `components/display/` 下组件。
- 修改角色/光锥配置字段：看 `src/main/stores/characters.ts`、`src/main/stores/lightCones.ts`，并同步检查相关 IPC 和 `src/shared/types.ts`。

## 不建议随意修改

不要随意修改 `node_modules/`、`out/`、`build/`、`package-lock.json`。`src/shared/types.ts` 会影响主进程、渲染进程和存档结构；`src/main/ipc/displaySettings.ts` 集中处理保存/读取和资源路径归一化；`electron-builder.yml`、`electron.vite.config.ts` 是构建配置，非相关任务不要动。

## 给新 Codex 窗口的使用说明

先读本文件，不要一上来全仓库扫描。根据任务只打开相关文件，优先用 `rg` 定位组件、函数和样式类。修改前先说明计划。除非用户明确要求，不要改业务逻辑、配置字段名、数据结构、保存/读取/预览/选择文件等既有行为。完成后运行 `npm run typecheck` 和 `npm run lint`，并说明改动文件与验证结果。

## 编号管理
assets/
    audios/
      ban/
        ban_0000x.wav
      pick/
        pick_0000x.wav
    characters/
      big/
        pick_0000x.png
      small/
        ban_0000x.png
      right/
        right_0000x.png
      left/
        left_0000x.png
    videos/
      chant/
        chant_0000x.png
      PV/
        PV_0000x.png