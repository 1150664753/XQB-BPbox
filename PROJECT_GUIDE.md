# XQB-BPbox 项目指南

> 当前软件版本：`1.2.2`
>
> 本文同时面向第一次使用 XQB-BPbox 的用户和参与维护的开发者。更细的素材字段与界面截图见[《操作指南》](./操作指南.md)。

## 目录

- [项目简介](#项目简介)
- [功能介绍](#功能介绍)
  - [本地 BP](#本地-bp)
  - [远程 BP](#远程-bp)
    - [BPbox 房主端](#bpbox-房主端)
    - [选手网页端](#选手网页端)
    - [整体流程](#整体流程)
- [安装与启动](#安装与启动)
  - [普通用户安装](#普通用户安装)
  - [源码开发启动](#源码开发启动)
  - [远程 BP 本地联调](#远程-bp-本地联调)
- [操作说明](#操作说明)
  - [资源与基础数据](#资源与基础数据)
  - [BPbox 基础操作](#bpbox-基础操作)
    - [创建和维护 BP 流程](#创建和维护-bp-流程)
    - [选择并应用流程](#选择并应用流程)
    - [开始和查看 BP](#开始和查看-bp)
  - [特效设置](#特效设置)
  - [底片视频](#底片视频)
  - [BPbox 远程 BP 操作](#bpbox-远程-bp-操作)
  - [手动回放与配音轴](#手动回放与配音轴)
  - [保存结果与输出画面](#保存结果与输出画面)
- [远程 BP 网站操作](#远程-bp-网站操作)
  - [访问地址](#访问地址)
  - [1. 获取房间信息](#1-获取房间信息)
  - [2. 加入房间](#2-加入房间)
  - [3. 进行 BP 操作](#3-进行-bp-操作)
  - [4. 注意事项](#4-注意事项)
- [开发说明](#开发说明)
  - [项目目录](#项目目录)
  - [BPbox 代码结构](#bpbox-代码结构)
  - [远程 BP 架构](#远程-bp-架构)
  - [数据流与权威边界](#数据流与权威边界)
  - [资源传输与安全边界](#资源传输与安全边界)
  - [远程 BP 配置](#远程-bp-配置)
  - [常见开发任务定位](#常见开发任务定位)
  - [检查与构建](#检查与构建)
  - [当前实现边界](#当前实现边界)
- [配置数据与备份](#配置数据与备份)
- [版本记录](#版本记录)
- [相关文档](#相关文档)

## 项目简介

XQB-BPbox 是一个自主可配置的 BP 控制软件，面向《崩坏：星穹铁道》相关赛事、社区活动和内容制作场景。它不只记录选择结果，还负责控制 BP 流程、观众画面、角色与光锥资源、音视频、特效和结果文件。

软件支持直播 BP、手动回放和配音轴联动等模式。用户可以自定义 PICK、BAN、保护、租借的执行顺序，也可以通过远程 BP 让选手在网页中参与操作；最终画面、流程推进和资源使用仍由 BPbox 自主控制。

项目的主要特点：

1. **高度可定制化**：BP 步骤、展示布局、事件变化、槽位、音视频和特效均可配置。
2. **覆盖常见 BP 场景**：支持角色与光锥、PICK 与 BAN、保护与租借、直播、复盘及配音编排，能够满足绝大多数 BP 场景需求。
3. **支持远程协作**：选手可通过独立网页加入房间，查看状态并提交操作。
4. **控制资源暴露范围**：远程端只接收 BP 所需的受控图片资源和精简状态，不会取得 BPbox 的本地文件路径。
5. **可扩展**：桌面端、网页端、信令层和传输层职责分离，便于扩展流程、协议与展示能力。

## 功能介绍

### 本地 BP

XQB-BPbox 的本地能力包括：

- 管理角色、光锥及其图片、视频、语音和音效引用。
- 创建、导入、读取和保存自定义 BP 流程。
- 配置展示背景、PICK/BAN 槽位、事件变化、唱名视频和操作特效。
- 使用独立预览窗口检查布局，并使用独立展示窗口输出正式画面。
- 在直播 BP 中按流程执行操作并保存结果。
- 读取已保存结果进行手动回放。
- 使用配音轴把音频时间点、BP 操作和额外点击对齐。

### 远程 BP

XQB-BPbox 支持基于信令服务和 WebRTC DataChannel 的远程 BP。信令服务只负责创建房间、分配选手槽位和交换 WebRTC 建连信息；连接建立后，BP 操作、状态和所需图片在选手网页与 BPbox 之间传输。

#### BPbox 房主端

BPbox 是远程 BP 的房主和权威状态源，负责：

- 创建和关闭远程 BP 房间。
- 管理房间生命周期及信令重连。
- 显示先手、后手的连接状态，并可单独踢出选手释放槽位。
- 维护 BP 状态、当前步骤和单调递增的 revision。
- 同步流程、正式结果、预选和等待状态。
- 按需提供角色头像、角色立绘和光锥图片。
- 接收并校验选手提交的操作请求。
- 将通过校验的操作交给现有 BP 状态机执行，再向网页广播最新状态。

房间没有固定的空闲过期时间。只有房主明确关闭房间时，房间才会终止并通知已连接选手。

#### 选手网页端

选手网页用于：

- 输入房间号并加入房间。
- 填写队伍或选手名称。
- 选择“先手”或“后手”身份。
- 查看当前阶段、操作方、进度、已 PICK/BAN 内容和连接状态。
- 按角色名称、属性、命途筛选角色，或按名称、命途筛选光锥。
- 预选、取消预选并确认当前操作。
- 在断线恢复后请求 BPbox 的最新权威状态。

网页不会自行认定操作已经生效。只有收到 BPbox 返回的新状态后，正式结果才会更新。

#### 整体流程

```text
BPbox 创建远程 BP 房间
        ↓
信令服务生成房间号
        ↓
选手打开远程 BP 网站并加入房间
        ↓
两名选手分别选择先手、后手
        ↓
信令服务协助建立 WebRTC DataChannel
        ↓
网页提交预选、取消预选或确认请求
        ↓
BPbox 校验请求并推进 BP 状态机
        ↓
BPbox 向双方网页和展示窗口同步最终 BP 状态
```

## 安装与启动

### 普通用户安装

1. 前往 [GitHub Releases](https://github.com/1150664753/XQB-BPbox/releases) 下载发布版本。
2. Windows 用户运行名称类似 `XQB-BPBox-<版本号>-setup.exe` 的安装程序。
3. 按安装向导完成安装，从桌面快捷方式或开始菜单启动软件。
4. 第一次启动后，软件会创建本地的 `assets`、`config` 和 `results` 数据目录。

普通用户不需要安装 Node.js。控制台中的更新按钮可检查新版本；更新失败时可重新下载安装包。

### 源码开发启动

完整项目包含三个可独立安装依赖的 Node.js 工程。若需要同时开发信令服务，使用 Node.js 22 或更高版本。

启动 BPbox：

```bash
cd XQB-BPbox
npm install
npm run dev
```

启动选手网页：

```bash
cd XBQ-BPweb
npm install
npm run dev -- --host 0.0.0.0
```

启动本地信令服务：

```bash
cd remote-bp-signaling
npm install
npm start
```

### 远程 BP 本地联调

网页开发模式默认连接 `ws://localhost:8787`，BPbox 默认连接公网信令地址。使用本地信令服务联调时，在 `XQB-BPbox/.env.local` 中配置：

```text
VITE_REMOTE_BP_HOST_TRANSPORT=webrtc
VITE_REMOTE_BP_SIGNALING_URL=ws://localhost:8787
VITE_REMOTE_BP_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]
```

跨设备局域网联调时，还要把网页端和 BPbox 的信令地址都改为选手设备能够访问的局域网地址，并允许防火墙访问对应端口。若只需离线演示网页或自检传输层，可把相应 Transport 配置为 `mock`。

## 操作说明

### 资源与基础数据

第一次使用时，先准备 BP 所需的基础数据：

1. 在“角色管理”中维护角色名称、属性、命途、星级和图片、视频、语音、音效引用。
2. 在“光锥管理”中维护光锥名称、命途和图片引用。
3. 大量角色可使用“角色批量管理”按编号匹配已有素材。
4. 在“展示页设置”中打开预览页面，检查图片、视频和声音能否正常加载。

通过文件选择器引用项目数据目录内的资源时通常保存相对路径；引用目录外文件时可能保存绝对路径。迁移电脑前应连同资源一起备份。

### BPbox 基础操作

#### 创建和维护 BP 流程

1. 进入“BP流程配置”，填写流程名称。
2. 点击“添加步骤”，为普通步骤选择先手或后手、PICK 或 BAN，以及角色或光锥目标。
3. 需要特殊步骤时点击“添加保护”或“添加租借”。这两类步骤作用于双方已 PICK 的角色。
4. 使用上移、下移和删除调整执行顺序。
5. 如需驱动展示变化，在步骤的“事件触发”中填写事件名，并确保它与展示设置中的“响应事件”完全一致。
6. 点击“保存当前流程”。流程至少需要一个步骤。

也可以使用内置默认流程进行快速测试，或从本地导入流程 JSON；导入后仍需保存，才会写入 `config/bp`。

#### 选择并应用流程

1. 进入“开始BP”。
2. 在“BP 流程”卡片的“选择流程”中选择已保存的流程。
3. 点击“应用所选流程”。
4. 若要直接使用当前正在编辑的流程，点击“同步编辑中的流程”。
5. 核对流程名称、步骤总数及各类槽位数量。

切换流程会改变本局状态机的步骤定义。已有操作需要保留时，应先保存结果，再切换或清空。

#### 开始和查看 BP

1. 填写本局结果名称，并选择需要的底片视频。
2. 点击“直播 BP”进入直播模式并打开独立展示窗口；读取历史结果后可改用“手动回放”。
3. 在中间的“当前 BP 阶段”查看动作、操作方、目标类型和进度。
4. 本地操作普通 PICK/BAN 时，点击符合当前步骤的角色或光锥会立即确认并进入下一步。
5. 保护或租借步骤需要双方各选一个符合规则的已 PICK 角色；两项都满足后才会推进。
6. 如果页面提示“等待额外点击”，先点击“触发额外点击”，直到提示解除。

当前界面没有另设一个“开始流程”按钮。“直播 BP”负责切换模式和打开输出窗口，流程从当前第一步进入可操作状态，第一次有效操作后开始推进。

### 特效设置

特效位于“展示页设置 → 特效设置”，分为 PICK 槽、BAN 槽、保护和租借四类。

PICK/BAN 特效设置：

1. 选择要编辑的 PICK 槽或 BAN 槽特效。
2. 为“待选特效”选择视频，并设置 X、Y、缩放和事件后延迟激活条件。
3. 为“确选特效”选择确认时播放的视频。
4. 需要声音时选择“确选音效”。
5. 打开预览页面，按对应流程事件检查位置、图层、触发时机和声音。

保护与租借效果设置：

1. 选择保护或租借分类。
2. 为“循环特效”选择视频；需要持续显示时启用“一直循环”。
3. 按需设置确选特效和确选音效。
4. 点击“播放”在独立预览中检查循环效果。

素材首次加载可能有延迟。正式活动前应完整测试待选、确选、循环和音效，不要只依赖静态配置值判断。

### 底片视频

“开始BP”中的“底片视频”是展示页没有角色唱名或角色 PV 时使用的默认视频。

1. 点击“选择底片视频”，选择 MP4 文件。
2. 设置“开始时间”，表示从视频第几秒开始播放。
3. 设置“结束时间”，表示从视频尾部排除多少秒，而不是视频中的绝对结束时间。
4. 打开直播、手动回放或配音轴展示页检查播放区间。

底片视频也承担开场画面的用途：展示页打开且尚未执行第一项 BP 操作时，会使用当前底片视频。项目没有单独的“开场 PV”选择入口。角色操作发生后，如配置了唱名视频和角色 PV，展示页会先播放唱名内容，再切换到角色 PV；没有可用角色 PV 时会恢复底片视频。

选择底片视频时，软件会建立或更新当前 BP 结果记录。迁移结果文件时也要保留对应视频文件。

### BPbox 远程 BP 操作

1. 打开 XQB-BPbox。
2. 进入“开始BP”，选择并应用本场流程。
3. 点击“直播 BP”，确认独立展示窗口已经打开且当前阶段正确。
4. 在“远程 BP”卡片中点击“创建远程 BP”。
5. 等待信令状态显示为“已连接”，复制服务器生成的 6 位房间号。
6. 把[远程 BP 网站](https://xqbbp.dpdns.org)和房间号发送给选手。
7. 等待选手加入，确认先手与后手均显示“已连接”。
8. 开始 BP。网页预选会同步到 BPbox，网页确认后由 BPbox 校验并写入正式结果。
9. 如需更换某名选手，使用其状态行中的踢出按钮释放对应槽位。
10. 本场结束后先保存结果，再点击“关闭房间”。

创建房间后，卡片还会显示 revision、可提供资源数量和信令状态。房主可以继续使用 BPbox 的本地控制、撤回、清空和额外点击能力；这些权威变化会同步到网页。

### 手动回放与配音轴

手动回放：

1. 从结果列表选择文件，点击“读取选中结果”。
2. 点击“手动回放”打开独立展示窗口。
3. 在展示窗口中使用 `→`、空格、小键盘 `6` 或鼠标单击向前推进，使用 `←` 后退一个 BP 操作。
4. 存在延迟变化时，一次向前操作可能只完成一次额外点击，不一定推进 BP 步骤。

配音轴：

1. 进入“配音轴”，创建或读取一个配音轴文件。
2. 选择 BP 流程和已保存的 BP 结果，再导入音频。
3. 移动播放头，在目标时间插入 BP 内容。
4. 展示设置包含延迟变化时，插入相应数量的额外点击。
5. 保存配音轴并点击“打开展示页”。播放、暂停、速度和时间点会与展示页联动。

配音轴联动时，展示窗口的手动推进会被禁用，避免破坏音频同步。

### 保存结果与输出画面

- “保存本局”把当前流程、操作记录和底片视频设置写入 `results/bp`。
- “撤回上一步”移除最后一条操作并重置当前延迟点击状态。
- “清空本局”清除本局操作并回到流程开头。
- 结果不会在每一步后自动保存，正式活动中应在关键节点主动保存。
- 在 OBS 中使用窗口采集时，应选择 XQB-BPbox 的独立展示窗口，并按 1920 × 1080、16:9 检查画面与声音。

## 远程 BP 网站操作

远程 BP 网站用于选手连接由 BPbox 创建的房间。它不是独立的 BP 房主，也不能在没有 BPbox 的情况下创建正式房间。

### 访问地址

当前公开网站地址：[https://xqbbp.dpdns.org](https://xqbbp.dpdns.org)

也可以使用 `https://xqbbp.dpdns.org/room/<房间号>` 预填房间号。该地址来自仓库中的 `remote-bp-signaling/README.md` 和 `docs/REMOTE_BP_WEBRTC_STAGE.md`；网页生产配置连接的公网信令地址为 `wss://signal.xqbbp.dpdns.org`。

### 1. 获取房间信息

房主在 BPbox 中点击“创建远程 BP”后，会获得：

- 由信令服务生成的 6 位房间号。
- “远程 BP”卡片中的信令状态、选手连接状态和 revision。

房主应把公开网站地址和房间号发给选手。当前 BPbox 提供房间号复制按钮，但不会自动生成邀请消息。

### 2. 加入房间

1. 打开远程 BP 网站。
2. 输入房主提供的房间号。
3. 填写“队伍或选手名称”。该名称用于两端展示，不会改变操作权限。
4. 选择身份：**先手**或**后手**。
5. 点击“加入房间”，等待连接状态变为已连接。

同一身份同一时间只能由一名选手占用。如果身份已被占用，应联系房主确认分配或释放对应槽位。

### 3. 进行 BP 操作

加入成功后，网页会显示：

- 当前 BP 阶段和操作类型。
- 当前操作方、流程名称、步骤进度和 revision。
- 双方已 PICK、已 BAN 的角色或光锥。
- 可操作与不可操作目标。
- 当前预选目标、确认状态、连接状态、资源加载数量和延迟。

当前操作语义如下：

| 操作 | 网页中的实际行为 |
| --- | --- |
| `PICK` / `BAN` | 表示当前权威流程阶段及最终结果；网页不直接写入结果 |
| `SELECT` | 点击一个可操作角色或光锥，向 BPbox 提交预选 |
| `DESELECT` | 再次点击自己的当前预选，向 BPbox 提交取消预选 |
| `CONFIRM` | 点击确认按钮，请求 BPbox 按当前 PICK/BAN/特殊步骤执行 |
| `PROTECT` / `BORROW` | 双方分别选择合法目标并确认，全部确认后由 BPbox 推进 |
| `WAIT` | 等待对方或等待房主完成额外操作，此时不能提交选择 |

推荐操作顺序：

1. 确认页面显示轮到自己操作，并检查目标是角色还是光锥。
2. 使用搜索、属性或命途筛选目标。
3. 点击可操作目标进行预选；点错时再次点击取消预选。
4. 检查当前预览后点击确认按钮。
5. 等待 BPbox 返回操作结果和新 revision，再进行下一项操作。

请求发送后按钮会暂时锁定。不要反复刷新或连续提交；BPbox 会使用 actionId、revision、当前步骤和身份重新校验请求。

### 4. 注意事项

- 房间必须由 BPbox 端创建，网页不能自行创建正式房间。
- 房主关闭房间后，选手会收到“房间已关闭”，连接不会自动恢复。
- 房主踢出某名选手后，该选手不会自动重连；房间的对应槽位可以由其他选手加入。
- 网络短暂中断时，网页会尝试重连并在恢复后请求最新状态。重连期间不要重复操作。
- P2P 连接受双方 NAT、防火墙、校园网、企业网和移动网络环境影响。
- 项目目前默认配置公共 STUN，但没有部署生产 TURN 中继；部分网络环境可能因此无法建立直连。
- 图片资源按需从 BPbox 传输。资源计数尚未完成时可以先等待，刷新页面会清空当前内存图片缓存并重新请求。

## 开发说明

### 项目目录

```text
XQB-BP/
├─ XQB-BPbox/                 Electron 桌面端、展示页与远程房主端
│  ├─ src/main/              主进程、窗口、本地存储、IPC、资源提供器
│  ├─ src/preload/           window.bpAPI 桥接及类型
│  ├─ src/renderer/src/      React 控制台、展示页、预览页和远程房间 UI
│  ├─ src/shared/            共用数据类型、状态逻辑和远程 BP 核心
│  ├─ assets/                开发时使用的本地资源目录
│  ├─ config/                运行时生成的配置目录
│  └─ results/               运行时生成的结果目录
├─ XBQ-BPweb/                远程 BP 选手网页项目
├─ remote-bp-signaling/      本地与 Cloudflare Worker 信令服务
├─ docs/                     开发记录和文档图片
├─ 操作指南.md               带截图的详细用户教程
├─ README.md                 项目入口、授权和快速启动
└─ CHANGELOG.md              版本变更记录
```

`XBQ-BPweb` 是仓库中已经使用的实际目录名；产品桌面端名称仍为 XQB-BPbox。

### BPbox 代码结构

关键入口：

- `XQB-BPbox/src/main/index.ts`：Electron 主进程入口。
- `XQB-BPbox/src/main/windows.ts`：控制台、展示页和预览页窗口管理。
- `XQB-BPbox/src/main/protocols.ts`：本地资源自定义协议。
- `XQB-BPbox/src/preload/index.ts`：主进程能力到渲染进程的安全桥接。
- `XQB-BPbox/src/renderer/src/main.tsx`：React 渲染进程入口。
- `XQB-BPbox/src/renderer/src/App.tsx`：根据 hash 进入控制台、展示页或预览页。
- `XQB-BPbox/src/renderer/src/pages/ConsolePage.tsx`：角色、光锥、流程、展示设置和 BP 控制台。
- `XQB-BPbox/src/renderer/src/pages/DisplayPage.tsx`：正式展示与音视频播放。
- `XQB-BPbox/src/renderer/src/pages/PreviewPage.tsx`：展示设置预览。
- `XQB-BPbox/src/renderer/src/components/display/DisplayCanvas.tsx`：展示画布及槽位组件组合。

本地存储与 IPC：

- `src/main/assets.ts`：数据根目录、目录初始化、资源路径与扫描。
- `src/main/stores/characters.ts`、`lightCones.ts`：角色与光锥配置读写。
- `src/main/ipc/flows.ts`：BP 流程读取、保存和导入。
- `src/main/ipc/displaySettings.ts`：展示设置读写、实时更新和资源路径归一化。
- `src/main/ipc/voiceTimelines.ts`：配音轴配置读写。
- `src/main/ipc/bp.ts`：BP 状态、展示窗口、结果和回放相关 IPC。
- `src/main/ipc/remoteBp.ts`：远程图片资源 Manifest 和文件读取桥接。

### 远程 BP 架构

远程 BP 由五个核心部分组成：

1. **Signaling Server**：`remote-bp-signaling` 提供本地 Node.js WebSocket 服务和 Cloudflare Worker 实现。公网实现使用 Durable Object 保存每个房间的信令状态，负责生成房间号、分配 HOST/FIRST/SECOND 槽位、转发 SDP 与 ICE、心跳、房主恢复、踢出和关闭房间。它不转发正式 BP 状态或图片资源。

2. **WebRTC DataChannel**：BPbox 为每名选手建立独立的 `RTCPeerConnection` 和有序 DataChannel。Action、状态、Ping/Pong、资源清单和图片分片通过该通道传输。当前控制消息与图片分片共用一个有序通道。

3. **STUN/TURN**：STUN/TURN 由 `RTCIceServer[]` 配置。默认只有 `stun:stun.l.google.com:19302`；代码支持加入标准 TURN URL、用户名和凭据，但项目目前没有提供生产 TURN 服务。

4. **RemoteBpHost**：`XQB-BPbox/src/shared/remoteBp/host.ts` 管理房间、选手状态、状态广播、动作结果和资源请求；`WebRtcRemoteHostTransport.ts` 负责真实信令及 WebRTC；`BpActionDispatcher` 负责动作幂等、revision、步骤、身份和目标校验。

5. **Web Client**：`XBQ-BPweb` 使用 `WebRtcRemoteBpConnection` 处理信令、重连和 DataChannel，`RemoteBpSessionStore` 保存 BPbox 权威状态在浏览器中的只读投影，页面组件只展示状态并提交操作。`RemoteAssetManager` 负责按需请求、校验和显示图片。

### 数据流与权威边界

```text
选手网页
  ↓ SELECT / DESELECT / CONFIRM 请求
WebRTC DataChannel
  ↓
RemoteBpHost
  ↓ 身份、步骤、目标、actionId、revision 校验
BpActionDispatcher
  ↓
BPbox BP 状态机
  ↓ 生成新的 RemoteBpState
展示窗口 + BPbox 控制台 + 双方网页
```

**BPbox 是唯一权威状态源。** 网页端不直接修改正式 BP 状态，只提交操作请求。网页不会乐观写入 PICK/BAN 结果；请求被接受后，也要以 BPbox 广播的新 `RemoteBpState` 为准。

本地按钮和远程请求最终复用同一个 Dispatcher 与现有 BP 执行器。每个远程 Action 携带 `actionId`、`expectedRevision`、`stepIndex` 和身份；重复请求、过期状态、错误轮次或非法目标都会被拒绝。只有合法且实际改变状态的操作才推进 revision。

当直播展示变化仍需房主执行额外点击时，BPbox 发布 `WAIT`，网页清空可操作目标并禁止确认，避免选手在画面节拍尚未完成时提前操作。

### 资源传输与安全边界

远程资源不是网页可访问的桌面文件路径。BPbox 会生成无路径的 Asset Manifest，并只允许传输：

- 角色头像小图。
- 角色全身立绘。
- 光锥小图。

当前保护措施：

- 使用受控的 assetId 到本地文件映射，不向网页公开真实路径。
- 拒绝未知 assetId、路径式请求、空文件、非图片和超过 64 MiB 的单个资源。
- Manifest 包含 SHA-256、大小和 MIME；网页重组前后进行一致性校验。
- 图片按 128 KiB 原始分片编码为 Base64 发送，并使用发送缓冲区背压。
- 信令消息最大 64 KiB，BP DataChannel JSON 最大 512 KiB。
- WebRTC DataChannel 提供点到点的加密传输；应用层校验用于限制内容范围并检查完整性。

网页按需加载资源：角色池先请求头像，选中后请求立绘，进入光锥阶段后请求光锥图片。当前缓存位于浏览器内存，刷新后会重新请求。

### 远程 BP 配置

BPbox：

```text
VITE_REMOTE_BP_HOST_TRANSPORT=webrtc
VITE_REMOTE_BP_SIGNALING_URL=wss://signal.xqbbp.dpdns.org
VITE_REMOTE_BP_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]
```

选手网页：

```text
VITE_REMOTE_BP_TRANSPORT=webrtc
VITE_REMOTE_BP_SIGNALING_URL=wss://signal.xqbbp.dpdns.org
VITE_REMOTE_BP_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]
```

配置位置分别参考 `XQB-BPbox/.env.example` 和 `XBQ-BPweb/.env.example`。部署环境的专用地址或 TURN 凭据应放在 `.env.local` 或部署平台环境变量中，不应写入业务代码。

公网信令服务：

- WebSocket：`wss://signal.xqbbp.dpdns.org`
- 健康检查：`https://signal.xqbbp.dpdns.org/health`
- 选手网站：`https://xqbbp.dpdns.org`

### 常见开发任务定位

- 修改控制台导航或主操作页：`ConsolePage.tsx` 和 `light-workbench.css`。
- 修改展示设置 UI：`ConsolePage.tsx` 中的展示设置组件、`display-settings.css`。
- 修改正式展示效果：`DisplayPage.tsx` 和 `components/display/`。
- 修改预览：`PreviewPage.tsx`、`DisplayCanvas.tsx`、`src/main/ipc/bp.ts`。
- 修改远程房间卡片：`components/remoteBp/RemoteBpPanel.tsx`、`styles/remote-bp.css`。
- 修改远程状态或 Action：`src/shared/remoteBp/types.ts`、`dispatcher.ts`、`serializer.ts`、`validation.ts`。
- 修改 BPbox WebRTC：`services/remoteBp/WebRtcRemoteHostTransport.ts`。
- 修改网页连接与重连：`XBQ-BPweb/src/services/WebRtcRemoteBpConnection.ts`。
- 修改网页操作状态：`XBQ-BPweb/src/stores/RemoteBpSessionStore.ts` 和 `src/pages/`。
- 修改资源允许范围：`src/main/remoteBp/projectRemoteAssetProvider.ts`、`RemoteAssetProvider.ts`。
- 修改信令房间协议：同步检查 `remote-bp-signaling/src/`、BPbox Transport 和网页 Connection。

`src/shared/types.ts` 会影响主进程、渲染进程、配置和存档结构；改字段时必须同步检查 IPC、读取兼容和展示页。不要手工修改 `node_modules`、`out` 或 `build`。

### 检查与构建

BPbox：

```bash
cd XQB-BPbox
npm run typecheck
npm run lint
npm run test:remote-bp
npm run build:win
```

选手网页：

```bash
cd XBQ-BPweb
npm run build
```

信令服务：

```bash
cd remote-bp-signaling
npm run test:local
npm run typecheck
npm test
```

`npm test` 会使用本地 Wrangler runtime 检查 Cloudflare Worker 房间流程；`npm run test:local` 检查保留的 Node.js 信令实现。

### 当前实现边界

- 远程协议版本为 `1.2.1`，BPbox 与网页端需要使用兼容版本。
- 公网信令和网页地址已经配置，项目目前没有生产 TURN 服务。
- 网页当前通过 `SELECT`、`DESELECT` 和 `CONFIRM` 完成交互；PICK/BAN 是权威流程阶段和最终状态，不是网页直接写入。
- 图片资源使用同一有序 DataChannel 的 Base64 JSON 分片，尚未拆分独立二进制资源通道。
- 网页图片缓存目前是内存缓存，尚未使用 IndexedDB 持久化。
- 远程端只同步 BP 所需图片，不传输 BPbox 本地音频、视频或配置文件。
- 房间不使用固定空闲 TTL；房主明确关闭房间后才结束生命周期。

## 配置数据与备份

主要本地数据：

| 内容 | 相对数据根目录的位置 |
| --- | --- |
| 角色 | `config/app/characters.json` |
| 光锥 | `config/app/light-cones.json` |
| 角色批量表 | `config/app/character-resource-table.json` |
| BP 流程 | `config/bp/*.json` |
| 展示设置 | `config/display/*.json` |
| 配音轴 | `config/audio/*.json` |
| BP 结果 | `results/bp/*.json` |
| 本地素材 | `assets/` 或配置中引用的外部路径 |

开发模式下，数据根目录默认是启动 BPbox 时的工作目录；安装版本使用 Electron 的 `userData` 目录。最可靠的定位方式是点击相应文件列表上的“目录”按钮。开发时也可通过 `XQB_BP_ROOT` 环境变量指定数据根目录。

备份或迁移时应同时复制 `config`、`results`、`assets` 及所有外部引用素材。只复制 JSON 而不复制素材会造成路径失效。流程或展示设置正在使用时，手工替换文件后应回到界面重新读取并预览。

## 版本记录

### 1.2.2

- 完善远程 BP 文档。
- 增加远程 BP 网站使用说明。
- 优化操作手册结构。
- 增加 Markdown 目录。

本次应用版本升级不改变远程 BP 协议版本；协议仍为 `1.2.1`。先手/后手连接状态、分侧踢出、权威 `WAIT`、信令与 DataChannel 心跳、房主房间恢复和网页重连等能力继续保持兼容。完整历史见 [CHANGELOG.md](./CHANGELOG.md)。

## 相关文档

- [README.md](./README.md)：项目定位、下载、源码运行和授权入口。
- [操作指南.md](./操作指南.md)：带界面截图的详细用户操作教程。
- [XQB-BPbox/REMOTE_BP_GUIDE.md](./XQB-BPbox/REMOTE_BP_GUIDE.md)：BPbox 房主端权威边界和配置。
- [XBQ-BPweb/README.md](./XBQ-BPweb/README.md)：网页端运行与部署。
- [XBQ-BPweb/WEB_GUIDE.md](./XBQ-BPweb/WEB_GUIDE.md)：网页端协议和代码分层说明。
- [remote-bp-signaling/README.md](./remote-bp-signaling/README.md)：信令服务、部署地址和房间生命周期。
- [docs/REMOTE_BP_WEBRTC_STAGE.md](./docs/REMOTE_BP_WEBRTC_STAGE.md)：远程 BP 1.2.1 实现记录和联调步骤。
- [CHANGELOG.md](./CHANGELOG.md)：版本变更记录。
