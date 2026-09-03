import type {
  AssetManifest,
  AssetManifestEntry,
  ReceivedAsset,
} from "../types/assets";
import type {
  PlayerSide,
  RemoteBpOperation,
  RemoteBpPhase,
  RemoteBpState,
  RemoteCharacterDto,
  RemoteLightConeDto,
} from "../types/bp";

interface MockCharacterSeed {
  id: string;
  name: string;
  element: string;
  path: string;
}

export const MOCK_CHARACTER_SEEDS: MockCharacterSeed[] = [
  { id: "1", name: "克拉拉", element: "物理", path: "毁灭" },
  { id: "2", name: "刃", element: "风", path: "毁灭" },
  { id: "3", name: "丹恒", element: "虚数", path: "毁灭" },
  { id: "4", name: "镜流", element: "冰", path: "毁灭" },
  { id: "5", name: "流萤", element: "火", path: "毁灭" },
  { id: "6", name: "云璃", element: "物理", path: "毁灭" },
  { id: "7", name: "万敌", element: "虚数", path: "毁灭" },
  { id: "8", name: "白厄", element: "物理", path: "毁灭" },
  { id: "9", name: "Saber", element: "风", path: "毁灭" },
  { id: "10", name: "素裳", element: "物理", path: "巡猎" },
  { id: "11", name: "三月七·巡猎", element: "虚数", path: "巡猎" },
  { id: "12", name: "貊泽", element: "雷", path: "巡猎" },
  { id: "13", name: "彦卿", element: "冰", path: "巡猎" },
  { id: "14", name: "希儿", element: "量子", path: "巡猎" },
];

export interface MockFlowStep {
  actor: PlayerSide;
  operation: Extract<RemoteBpOperation, "BAN" | "PICK">;
  targetType: "CHARACTER" | "LIGHT_CONE";
}

export const MOCK_FLOW: MockFlowStep[] = [
  { actor: "first", operation: "BAN", targetType: "CHARACTER" },
  { actor: "second", operation: "BAN", targetType: "CHARACTER" },
  { actor: "first", operation: "PICK", targetType: "CHARACTER" },
  { actor: "second", operation: "PICK", targetType: "CHARACTER" },
  { actor: "first", operation: "BAN", targetType: "LIGHT_CONE" },
  { actor: "second", operation: "BAN", targetType: "LIGHT_CONE" },
  { actor: "first", operation: "PICK", targetType: "LIGHT_CONE" },
  { actor: "second", operation: "PICK", targetType: "LIGHT_CONE" },
];

const MOCK_LIGHT_CONE_SEEDS = [
  { id: "lc-1", name: "记一位星神的陨落", path: "毁灭" },
  { id: "lc-2", name: "于夜色中", path: "巡猎" },
  { id: "lc-3", name: "拂晓之前", path: "智识" },
  { id: "lc-4", name: "但战斗还未结束", path: "同谐" },
  { id: "lc-5", name: "棺的回响", path: "丰饶" },
  { id: "lc-6", name: "制胜的瞬间", path: "存护" },
];

function phaseFor(operation: RemoteBpOperation): RemoteBpPhase {
  if (operation === "BAN") return "BAN";
  if (operation === "PICK") return "PICK";
  return "COMPLETE";
}

export function createMockCharacters(): RemoteCharacterDto[] {
  return MOCK_CHARACTER_SEEDS.map((character) => ({
    id: character.id,
    name: character.name,
    avatar: `character:${character.id}:avatar`,
    portrait: `character:${character.id}:portrait`,
    element: character.element,
    path: character.path,
    enabled: true,
    selected: false,
    selectedBy: null,
    banned: false,
    picked: false,
  }));
}

export function createMockLightCones(): RemoteLightConeDto[] {
  return MOCK_LIGHT_CONE_SEEDS.map((lightCone) => ({
    ...lightCone,
    image: `light-cone:${lightCone.id}:image`,
    enabled: true,
    selected: false,
    selectedBy: null,
    banned: false,
    picked: false,
  }));
}

export function createInitialMockState(roomId: string): RemoteBpState {
  const firstStep = MOCK_FLOW[0];
  if (!firstStep) {
    throw new Error("Mock flow requires at least one step");
  }

  const characters = createMockCharacters();
  const lightCones = createMockLightCones();
  const initialTargetIds =
    firstStep.targetType === "CHARACTER"
      ? characters.map((character) => character.id)
      : lightCones.map((lightCone) => lightCone.id);
  return {
    schemaVersion: 1,
    revision: 1,
    sessionId: `mock-session-${roomId.toLowerCase()}`,
    roomId,
    flowName: "Mock · 标准角色 BP",
    status: "running",
    phase: phaseFor(firstStep.operation),
    currentActor: firstStep.actor,
    currentOperation: firstStep.operation,
    waitingForHost: false,
    currentStep: {
      id: "mock-step-1",
      index: 1,
      total: MOCK_FLOW.length,
      label: `第 1 步 · ${firstStep.actor === "first" ? "先手" : "后手"} ${firstStep.operation}`,
      targetType: firstStep.targetType,
    },
    playerConnections: { first: "connected", second: "connected" },
    sideMapping: { first: "star", second: "rail" },
    teams: {
      first: { side: "first", name: "先手选手", shortName: "FIRST" },
      second: { side: "second", name: "后手选手", shortName: "SECOND" },
    },
    characters,
    lightCones,
    bans: [],
    picks: [],
    lightConeBans: [],
    lightConePicks: [],
    protections: [],
    borrows: [],
    selections: { first: null, second: null },
    selectionTargets: { first: null, second: null },
    confirmedSides: { first: false, second: false },
    availableCharacterIds: characters.map((character) => character.id),
    unavailableCharacterIds: [],
    availableLightConeIds: lightCones.map((lightCone) => lightCone.id),
    unavailableLightConeIds: [],
    availableTargetIdsBySide: {
      first: firstStep.actor === "first" ? initialTargetIds : [],
      second: firstStep.actor === "second" ? initialTargetIds : [],
    },
    canConfirm: false,
    canConfirmBySide: { first: false, second: false },
    countdown: {
      durationMs: 60_000,
      remainingMs: 60_000,
      serverTime: new Date().toISOString(),
      running: false,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function createMockAssetManifest(): AssetManifest {
  const assets = MOCK_CHARACTER_SEEDS.flatMap<AssetManifestEntry>(
    (character) => [
      {
        assetId: `character:${character.id}:avatar`,
        type: "avatar",
        hash: `mock-${character.id}-avatar-v1`,
        size: 2048,
        mimeType: "image/svg+xml",
        characterId: character.id,
        ownerId: character.id,
      },
      {
        assetId: `character:${character.id}:portrait`,
        type: "portrait",
        hash: `mock-${character.id}-portrait-v1`,
        size: 4096,
        mimeType: "image/svg+xml",
        characterId: character.id,
        ownerId: character.id,
      },
    ],
  );
  assets.push(
    ...MOCK_LIGHT_CONE_SEEDS.map<AssetManifestEntry>((lightCone) => ({
      assetId: `light-cone:${lightCone.id}:image`,
      type: "light-cone",
      hash: `mock-${lightCone.id}-image-v1`,
      size: 2048,
      mimeType: "image/svg+xml",
      lightConeId: lightCone.id,
      ownerId: lightCone.id,
    })),
  );

  return {
    revision: 1,
    generatedAt: new Date().toISOString(),
    assets,
  };
}

const PALETTES = [
  ["#2274ff", "#20c8d9"],
  ["#e4578c", "#ff9b5f"],
  ["#7d5cff", "#b75cff"],
  ["#16a47c", "#8bcf5b"],
  ["#f36d38", "#ffc857"],
  ["#3559d8", "#8a87ff"],
] as const;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createMockAsset(descriptor: AssetManifestEntry): ReceivedAsset {
  const character = MOCK_CHARACTER_SEEDS.find(
    (item) => item.id === descriptor.characterId,
  );
  const lightCone = MOCK_LIGHT_CONE_SEEDS.find(
    (item) => item.id === descriptor.lightConeId,
  );
  const owner = character ?? lightCone;
  if (!owner) {
    throw new Error(`Mock asset owner not found: ${descriptor.assetId}`);
  }

  const palette =
    PALETTES[
      (character
        ? Number(character.id) - 1
        : MOCK_LIGHT_CONE_SEEDS.indexOf(lightCone!)) % PALETTES.length
    ] ?? PALETTES[0];
  const [startColor, endColor] = palette;
  const portrait = descriptor.type === "portrait";
  const width = portrait ? 600 : 320;
  const height = portrait ? 760 : 320;
  const fontSize = portrait ? 92 : 64;
  const safeName = escapeXml(owner.name);
  const initials = escapeXml(owner.name.slice(0, 2).toUpperCase());
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${startColor}"/><stop offset="1" stop-color="${endColor}"/></linearGradient></defs>
    <rect width="100%" height="100%" rx="28" fill="#0b1424"/>
    <circle cx="${width * 0.76}" cy="${height * 0.2}" r="${width * 0.45}" fill="url(#g)" opacity=".65"/>
    <circle cx="${width * 0.25}" cy="${height * 0.82}" r="${width * 0.55}" fill="url(#g)" opacity=".32"/>
    <text x="50%" y="47%" text-anchor="middle" dominant-baseline="middle" fill="white" font-family="sans-serif" font-size="${fontSize}" font-weight="800">${initials}</text>
    ${portrait ? `<text x="50%" y="88%" text-anchor="middle" fill="white" opacity=".86" font-family="sans-serif" font-size="34">${safeName}</text>` : ""}
  </svg>`;

  return {
    descriptor,
    data: new Blob([svg], { type: descriptor.mimeType }),
  };
}
