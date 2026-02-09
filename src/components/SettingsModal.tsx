import React, { useEffect, useMemo, useState } from 'react';
import type { CanonicalizeLayoutAlgorithm } from '../engine/WorldEngine';
import type { BackgroundLibraryItem } from '../model/backgrounds';
import { FONT_FAMILY_OPTIONS, type FontFamilyKey } from '../ui/typography';
import { useAttachmentObjectUrls } from '../ui/useAttachmentObjectUrls';
import type { ModelInfo } from '../llm/registry';
import {
  getAnthropicEffortOptions,
  normalizeAnthropicEffort,
  supportsAnthropicEffort,
  type AnthropicEffortSetting,
  type ModelUserSettings,
  type ModelUserSettingsById,
  type ReasoningSummarySetting,
} from '../llm/modelUserSettings';

export type SettingsPanelId = 'appearance' | 'models' | 'debug' | 'data' | 'reset';

type PanelDef = { id: SettingsPanelId; title: string; description: string };

type Props = {
  open: boolean;
  activePanel: SettingsPanelId;
  onChangePanel: (panel: SettingsPanelId) => void;
  onClose: () => void;

  models: ModelInfo[];
  modelUserSettings: ModelUserSettingsById;
  globalSystemInstruction: string;
  onChangeGlobalSystemInstruction: (next: string) => void;
  chatSystemInstructionOverride: string | null;
  onChangeChatSystemInstructionOverride: (next: string | null) => void;
  onResetChatSystemInstructionOverride: () => void;
  onUpdateModelUserSettings: (modelId: string, patch: Partial<ModelUserSettings>) => void;

  backgroundLibrary: BackgroundLibraryItem[];
  onUploadBackground: () => void;
  onRenameBackground: (backgroundId: string, name: string) => void;
  onDeleteBackground: (backgroundId: string) => void;

  composerFontFamily: FontFamilyKey;
  onChangeComposerFontFamily: (next: FontFamilyKey) => void;
  composerFontSizePx: number;
  onChangeComposerFontSizePx: (next: number) => void;
  nodeFontFamily: FontFamilyKey;
  onChangeNodeFontFamily: (next: FontFamilyKey) => void;
  nodeFontSizePx: number;
  onChangeNodeFontSizePx: (next: number) => void;
  sidebarFontFamily: FontFamilyKey;
  onChangeSidebarFontFamily: (next: FontFamilyKey) => void;
  sidebarFontSizePx: number;
  onChangeSidebarFontSizePx: (next: number) => void;

  edgeRouterId: string;
  edgeRouterOptions: Array<{ id: string; label: string; description: string }>;
  onChangeEdgeRouterId: (next: string) => void;

  replyArrowColor: string;
  onChangeReplyArrowColor: (next: string) => void;
  replyArrowOpacityPct: number;
  onChangeReplyArrowOpacityPct: (next: number) => void;

  glassNodesEnabled: boolean;
  onToggleGlassNodes: () => void;
  glassBlurBackend: 'webgl' | 'canvas';
  onChangeGlassBlurBackend: (next: 'webgl' | 'canvas') => void;
  glassBlurPx: number;
  onChangeGlassBlurPx: (next: number) => void;
  glassSaturationPct: number;
  onChangeGlassSaturationPct: (next: number) => void;
  uiGlassBlurPxWebgl: number;
  onChangeUiGlassBlurPxWebgl: (next: number) => void;
  uiGlassSaturationPctWebgl: number;
  onChangeUiGlassSaturationPctWebgl: (next: number) => void;
  glassOpacityPct: number;
  onChangeGlassOpacityPct: (next: number) => void;

  debugHudVisible: boolean;
  onToggleDebugHudVisible: () => void;
  sendAllEnabled: boolean;
  onToggleSendAllEnabled: () => void;
  sendAllModelIds: string[];
  onToggleSendAllModelId: (modelId: string) => void;
  allowEditingAllTextNodes: boolean;
  onToggleAllowEditingAllTextNodes: () => void;
  spawnEditNodeByDraw: boolean;
  onToggleSpawnEditNodeByDraw: () => void;
  spawnInkNodeByDraw: boolean;
  onToggleSpawnInkNodeByDraw: () => void;
  inkSendCropEnabled: boolean;
  onToggleInkSendCropEnabled: () => void;
  inkSendCropPaddingPx: number;
  onChangeInkSendCropPaddingPx: (next: number) => void;
  inkSendDownscaleEnabled: boolean;
  onToggleInkSendDownscaleEnabled: () => void;
  inkSendMaxPixels: number;
  onChangeInkSendMaxPixels: (next: number) => void;
  inkSendMaxDimPx: number;
  onChangeInkSendMaxDimPx: (next: number) => void;
  spawnCount: number;
  onChangeSpawnCount: (next: number) => void;
  onSpawnNodes: () => void;
  onClearStressNodes: () => void;
  onAutoResizeAllTextNodes: () => void;
  canonicalizeLayoutAlgorithm: CanonicalizeLayoutAlgorithm;
  onChangeCanonicalizeLayoutAlgorithm: (next: CanonicalizeLayoutAlgorithm) => void;
  onCanonicalizeLayout: () => void;

  onRequestImportChat: () => void;
  onExportAllChats: () => void;
  storagePath: string | null;
  storageDefaultPath: string | null;
  storagePathIsDefault: boolean;
  canManageStorageLocation: boolean;
  onChooseStorageLocation: () => void;
  onResetStorageLocation: () => void;
  canOpenStorageFolder: boolean;
  onOpenStorageFolder: () => void;
  cleanupChatFoldersOnDelete: boolean;
  onToggleCleanupChatFoldersOnDelete: () => void;

  onResetToDefaults: () => void;
};

export default function SettingsModal(props: Props) {
  const open = props.open;
  const onClose = props.onClose;
  const [renamingBackgroundId, setRenamingBackgroundId] = useState<string | null>(null);
  const [renameBackgroundDraft, setRenameBackgroundDraft] = useState('');
  const backgroundThumbUrls = useAttachmentObjectUrls(
    open && props.activePanel === 'appearance' ? (props.backgroundLibrary ?? []).map((b) => b.storageKey) : [],
  );

  const beginRenameBackground = (bg: BackgroundLibraryItem) => {
    setRenamingBackgroundId(bg.id);
    setRenameBackgroundDraft(bg.name);
  };

  const cancelRenameBackground = () => {
    setRenamingBackgroundId(null);
  };

  const commitRenameBackground = () => {
    const id = renamingBackgroundId;
    const next = renameBackgroundDraft.trim();
    setRenamingBackgroundId(null);
    if (!id) return;
    if (!next) return;
    props.onRenameBackground(id, next);
  };

  const edgeRouterDesc = useMemo(() => {
    const desc = props.edgeRouterOptions?.find((r) => r.id === props.edgeRouterId)?.description ?? '';
    return desc || 'Choose how reply arrows route between nodes.';
  }, [props.edgeRouterId, props.edgeRouterOptions]);

  const providers = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of props.models ?? []) {
      if (!m || typeof m.id !== 'string') continue;
      const key = typeof (m as any).provider === 'string' ? String((m as any).provider) : 'unknown';
      const list = byProvider.get(key) ?? [];
      list.push(m);
      byProvider.set(key, list);
    }
    const labelFor = (p: string) =>
      p === 'openai' ? 'OpenAI' : p === 'gemini' ? 'Gemini' : p === 'anthropic' ? 'Anthropic' : p === 'xai' ? 'xAI' : p;
    return Array.from(byProvider.entries())
      .map(([providerId, models]) => ({
        providerId,
        label: labelFor(providerId),
        models: models.slice().sort((a, b) => String(a.label ?? a.id).localeCompare(String(b.label ?? b.id))),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [props.models]);

  const chatSystemInstructionIsCustom = typeof props.chatSystemInstructionOverride === 'string';
  const chatSystemInstructionValue = chatSystemInstructionIsCustom
    ? props.chatSystemInstructionOverride ?? ''
    : props.globalSystemInstruction;

  const panels: PanelDef[] = useMemo(
    () => [
      {
        id: 'appearance',
        title: 'Appearance & Personalization',
        description: 'Background, typography, and glass nodes',
      },
      {
        id: 'models',
        title: 'Models',
        description: 'Providers, model list, and defaults',
      },
      {
        id: 'debug',
        title: 'Debug',
        description: 'HUD + stress test tools',
      },
      {
        id: 'data',
        title: 'Data',
        description: 'Import or export chats',
      },
      {
        id: 'reset',
        title: 'Reset or Clear Data',
        description: 'Clear backgrounds and delete chats',
      },
    ],
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settingsOverlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settingsOverlay__backdrop" onMouseDown={props.onClose} />
      <div
        className="settingsModal"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <div className="settingsModal__body">
          <div className="settingsModal__sidebar">
            <div className="settingsModal__sidebarTitle">Settings</div>
            <div className="settingsModal__sidebarList">
              {panels.map((panel) => (
                <button
                  key={panel.id}
                  type="button"
                  className={`settingsNavBtn ${props.activePanel === panel.id ? 'settingsNavBtn--active' : ''}`}
                  onClick={() => props.onChangePanel(panel.id)}
                >
                  <div className="settingsNavBtn__title">{panel.title}</div>
                  <div className="settingsNavBtn__desc">{panel.description}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="settingsModal__content">
            <div className="settingsModal__scroll">
            {props.activePanel === 'appearance' ? (
                <div className="settingsPanel">
                <div className="settingsPanel__header">
                  <div className="settingsPanel__title">Appearance &amp; Personalization</div>
                  <div className="settingsPanel__subtitle">Upload backgrounds and tune typography and glass nodes.</div>
                </div>

	                <div className="settingsCard">
	                  <div className="settingsRow">
	                    <div className="settingsRow__text">
	                      <div className="settingsRow__title">Background library</div>
	                      <div className="settingsRow__desc">Upload backgrounds once, then set per chat from the ⋮ menu in the sidebar.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button className="settingsBtn" type="button" onClick={props.onUploadBackground}>
                        Upload background
                      </button>
                    </div>
	                  </div>

                    {(props.backgroundLibrary ?? []).length ? (
                      <div className="settingsBgList" role="list" aria-label="Uploaded backgrounds">
                        {props.backgroundLibrary.map((bg) => {
                          const isRenaming = renamingBackgroundId === bg.id;
                          const thumbUrl = backgroundThumbUrls[bg.storageKey] || '';
                          return (
                            <div key={bg.id} className="settingsRow settingsBgList__row" role="listitem">
                              <div className="settingsRow__text settingsBgList__text">
                                <div className="settingsBgThumbWrap" aria-hidden="true">
                                  {thumbUrl ? (
                                    <img className="settingsBgThumb" src={thumbUrl} alt="" />
                                  ) : (
                                    <div className="settingsBgThumb settingsBgThumb--placeholder" />
                                  )}
                                </div>
                                <div className="settingsBgMeta">
                                  {isRenaming ? (
                                    <input
                                      className="settingsTextInput"
                                      value={renameBackgroundDraft}
                                      onChange={(e) => setRenameBackgroundDraft(e.target.value)}
                                      onBlur={commitRenameBackground}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.preventDefault();
                                          commitRenameBackground();
                                        } else if (e.key === 'Escape') {
                                          e.preventDefault();
                                          cancelRenameBackground();
                                        }
                                      }}
                                      autoFocus
                                    />
                                  ) : (
                                    <div className="settingsRow__title">{bg.name}</div>
                                  )}
                                  <div className="settingsRow__desc">
                                    {bg.mimeType ? bg.mimeType : 'Image attachment'}
                                    {typeof bg.size === 'number' ? ` • ${Math.round(bg.size / 1024)} KB` : ''}
                                  </div>
                                </div>
                              </div>
                              <div className="settingsRow__actions">
                                {isRenaming ? (
                                  <>
                                    <button
                                      className="settingsBtn"
                                      type="button"
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={commitRenameBackground}
                                    >
                                      Save
                                    </button>
                                    <button
                                      className="settingsBtn"
                                      type="button"
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={cancelRenameBackground}
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <button className="settingsBtn" type="button" onClick={() => beginRenameBackground(bg)}>
                                      Rename
                                    </button>
                                    <button
                                      className="settingsBtn settingsBtn--danger"
                                      type="button"
                                      onClick={() => props.onDeleteBackground(bg.id)}
                                    >
                                      Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="settingsRow">
                        <div className="settingsRow__text">
                          <div className="settingsRow__desc">No backgrounds uploaded yet.</div>
                        </div>
                      </div>
                    )}
	                </div>

	                <details className="settingsCard settingsDetails" open>
	                  <summary className="settingsDetails__summary">
	                    <div className="settingsRow settingsRow--stack">
	                      <div className="settingsRow__text">
                        <div className="settingsRow__title">Typography</div>
                        <div className="settingsRow__desc">Adjust fonts and sizes for composer, nodes, and sidebar.</div>
                      </div>
                    </div>
                  </summary>

                  <div className="settingsDetails__body">
                    <div className="settingsRow">
                      <div className="settingsRow__text">
                        <div className="settingsRow__title">Message composer</div>
                        <div className="settingsRow__desc">Applies to the input box and preview.</div>
                      </div>
                      <div className="settingsRow__actions">
                        <select
                          className="settingsSelect"
                          value={props.composerFontFamily}
                          onChange={(e) => props.onChangeComposerFontFamily(e.currentTarget.value as FontFamilyKey)}
                          aria-label="Composer font family"
                        >
                          {FONT_FAMILY_OPTIONS.map((opt) => (
                            <option key={opt.key} value={opt.key}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="settingsSlider">
                      <div className="settingsSlider__labelRow">
                        <span>Composer font size</span>
                        <span>{Math.round(props.composerFontSizePx)}px</span>
                      </div>
                      <input
                        className="settingsSlider__range"
                        type="range"
                        min={10}
                        max={30}
                        step={1}
                        value={Math.round(props.composerFontSizePx)}
                        onChange={(e) => props.onChangeComposerFontSizePx(Number(e.currentTarget.value))}
                      />
                    </div>

                    <div className="settingsRow">
                      <div className="settingsRow__text">
                        <div className="settingsRow__title">Node text</div>
                        <div className="settingsRow__desc">Text inside message nodes on the canvas.</div>
                      </div>
                      <div className="settingsRow__actions">
                        <select
                          className="settingsSelect"
                          value={props.nodeFontFamily}
                          onChange={(e) => props.onChangeNodeFontFamily(e.currentTarget.value as FontFamilyKey)}
                          aria-label="Node font family"
                        >
                          {FONT_FAMILY_OPTIONS.map((opt) => (
                            <option key={opt.key} value={opt.key}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="settingsSlider">
                      <div className="settingsSlider__labelRow">
                        <span>Node font size</span>
                        <span>{Math.round(props.nodeFontSizePx)}px</span>
                      </div>
                      <input
                        className="settingsSlider__range"
                        type="range"
                        min={10}
                        max={30}
                        step={1}
                        value={Math.round(props.nodeFontSizePx)}
                        onChange={(e) => props.onChangeNodeFontSizePx(Number(e.currentTarget.value))}
                      />
                    </div>

                    <div className="settingsRow">
                      <div className="settingsRow__text">
                        <div className="settingsRow__title">Sidebar chat list</div>
                        <div className="settingsRow__desc">Chat names in the left sidebar.</div>
                      </div>
                      <div className="settingsRow__actions">
                        <select
                          className="settingsSelect"
                          value={props.sidebarFontFamily}
                          onChange={(e) => props.onChangeSidebarFontFamily(e.currentTarget.value as FontFamilyKey)}
                          aria-label="Sidebar font family"
                        >
                          {FONT_FAMILY_OPTIONS.map((opt) => (
                            <option key={opt.key} value={opt.key}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="settingsSlider">
                      <div className="settingsSlider__labelRow">
                        <span>Sidebar font size</span>
                        <span>{Math.round(props.sidebarFontSizePx)}px</span>
                      </div>
                      <input
                        className="settingsSlider__range"
                        type="range"
                        min={8}
                        max={24}
                        step={1}
                        value={Math.round(props.sidebarFontSizePx)}
                        onChange={(e) => props.onChangeSidebarFontSizePx(Number(e.currentTarget.value))}
                      />
                    </div>
                  </div>
                </details>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Arrow routing</div>
                      <div className="settingsRow__desc">{edgeRouterDesc}</div>
                    </div>
                    <div className="settingsRow__actions">
                      <select
                        className="settingsSelect"
                        value={props.edgeRouterId}
                        onChange={(e) => props.onChangeEdgeRouterId(e.currentTarget.value)}
                        aria-label="Arrow routing"
                      >
                        {(props.edgeRouterOptions ?? []).map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Arrow color</div>
                      <div className="settingsRow__desc">Adjust the color of reply arrows between nodes.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <div className="settingsColorPicker">
                        <input
                          className="settingsColorInput"
                          type="color"
                          value={props.replyArrowColor}
                          onChange={(e) => props.onChangeReplyArrowColor(e.currentTarget.value)}
                          aria-label="Reply arrow color"
                        />
                        <span className="settingsColorHex">{String(props.replyArrowColor || '').toUpperCase()}</span>
                      </div>
                    </div>
                  </div>

                  <div className="settingsSlider">
                    <div className="settingsSlider__labelRow">
                      <span>Arrow opacity</span>
                      <span>{Math.round(props.replyArrowOpacityPct)}%</span>
                    </div>
                    <input
                      className="settingsSlider__range"
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(props.replyArrowOpacityPct)}
                      onChange={(e) => props.onChangeReplyArrowOpacityPct(Number(e.currentTarget.value))}
                    />
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Glass nodes</div>
                      <div className="settingsRow__desc">Toggle and tune the blur effect for nodes.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.glassNodesEnabled ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.glassNodesEnabled}
                        onClick={props.onToggleGlassNodes}
                      >
                        {props.glassNodesEnabled ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>

                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Glass blur renderer</div>
                      <div className="settingsRow__desc">Switch between WebGL (faster on mobile) and Canvas filter.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.glassBlurBackend === 'webgl' ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.glassBlurBackend === 'webgl'}
                        onClick={() => props.onChangeGlassBlurBackend('webgl')}
                      >
                        WebGL
                      </button>
                      <button
                        className={`settingsToggle ${props.glassBlurBackend === 'canvas' ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.glassBlurBackend === 'canvas'}
                        onClick={() => props.onChangeGlassBlurBackend('canvas')}
                      >
                        Canvas
                      </button>
                    </div>
                  </div>

                  <div className={`settingsSlider ${props.glassNodesEnabled ? '' : 'settingsSlider--disabled'}`}>
                    <div className="settingsSlider__labelRow">
                      <span>Glass blur</span>
                      <span>{Math.round(props.glassBlurPx)}px</span>
                    </div>
                    <input
                      className="settingsSlider__range"
                      type="range"
                      min={0}
                      max={30}
                      step={1}
                      disabled={!props.glassNodesEnabled}
                      value={Math.round(props.glassBlurPx)}
                      onChange={(e) => props.onChangeGlassBlurPx(Number(e.currentTarget.value))}
                    />
                  </div>

                  <div className={`settingsSlider ${props.glassNodesEnabled ? '' : 'settingsSlider--disabled'}`}>
                    <div className="settingsSlider__labelRow">
                      <span>Glass saturation</span>
                      <span>{Math.round(props.glassSaturationPct)}%</span>
                    </div>
                    <input
                      className="settingsSlider__range"
                      type="range"
                      min={100}
                      max={200}
                      step={1}
                      disabled={!props.glassNodesEnabled}
                      value={Math.round(props.glassSaturationPct)}
                      onChange={(e) => props.onChangeGlassSaturationPct(Number(e.currentTarget.value))}
                    />
                  </div>

                  {props.glassBlurBackend === 'webgl' ? (
                    <>
                      <div className="settingsSlider">
                        <div className="settingsSlider__labelRow">
                          <span>UI glass blur</span>
                          <span>{Math.round(props.uiGlassBlurPxWebgl)}px</span>
                        </div>
                        <input
                          className="settingsSlider__range"
                          type="range"
                          min={0}
                          max={30}
                          step={1}
                          value={Math.round(props.uiGlassBlurPxWebgl)}
                          onChange={(e) => props.onChangeUiGlassBlurPxWebgl(Number(e.currentTarget.value))}
                        />
                      </div>

                      <div className="settingsSlider">
                        <div className="settingsSlider__labelRow">
                          <span>UI glass saturation</span>
                          <span>{Math.round(props.uiGlassSaturationPctWebgl)}%</span>
                        </div>
                        <input
                          className="settingsSlider__range"
                          type="range"
                          min={100}
                          max={200}
                          step={1}
                          value={Math.round(props.uiGlassSaturationPctWebgl)}
                          onChange={(e) => props.onChangeUiGlassSaturationPctWebgl(Number(e.currentTarget.value))}
                        />
                      </div>
                    </>
                  ) : null}

                  <div className={`settingsSlider ${props.glassNodesEnabled ? '' : 'settingsSlider--disabled'}`}>
                    <div className="settingsSlider__labelRow">
                      <span>Glass opacity</span>
                      <span>{Math.round(props.glassOpacityPct)}%</span>
                    </div>
                    <input
                      className="settingsSlider__range"
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      disabled={!props.glassNodesEnabled}
                      value={Math.round(props.glassOpacityPct)}
                      onChange={(e) => props.onChangeGlassOpacityPct(Number(e.currentTarget.value))}
                    />
                  </div>
                </div>

                </div>
            ) : null}

            {props.activePanel === 'models' ? (
              <div className="settingsPanel">
                <div className="settingsPanel__header">
                  <div className="settingsPanel__title">Models</div>
                  <div className="settingsPanel__subtitle">Choose which models appear in the composer and set per-model defaults.</div>
                </div>

                <details className="settingsCard settingsDetails">
                  <summary className="settingsDetails__summary">
                    <div className="settingsRow settingsRow--stack">
                      <div className="settingsRow__text">
                        <div className="settingsRow__title">System instructions</div>
                        <div className="settingsRow__desc">Global default and per-chat override.</div>
                      </div>
                    </div>
                  </summary>

                  <div className="settingsDetails__body">
                    <div className="settingsRow settingsRow--stack">
                      <div className="settingsRow__text">
                        <div className="settingsRow__title">Global system instruction</div>
                        <div className="settingsRow__desc">Used by chats that do not have a chat-specific override.</div>
                      </div>
                      <div className="settingsRow__actions settingsRow__actions--grow">
                        <textarea
                          className="settingsTextArea"
                          rows={8}
                          value={props.globalSystemInstruction}
                          onChange={(e) => props.onChangeGlobalSystemInstruction(e.currentTarget.value)}
                          aria-label="Global system instruction"
                        />
                      </div>
                    </div>

                    <div className="settingsRow settingsRow--stack">
                      <div className="settingsRow__text">
                        <div className="settingsRow__title">This chat system instruction</div>
                        <div className="settingsRow__desc">
                          {chatSystemInstructionIsCustom ? 'Custom override active for this chat.' : 'Using the global default.'} Applies to new messages only.
                        </div>
                        <div className="settingsInlineActions">
                          <button
                            className="settingsBtn"
                            type="button"
                            onClick={props.onResetChatSystemInstructionOverride}
                            disabled={!chatSystemInstructionIsCustom}
                          >
                            Reset to default
                          </button>
                        </div>
                      </div>
                      <div className="settingsRow__actions settingsRow__actions--grow">
                        <textarea
                          className="settingsTextArea"
                          rows={8}
                          value={chatSystemInstructionValue}
                          onChange={(e) => props.onChangeChatSystemInstructionOverride(e.currentTarget.value)}
                          aria-label="This chat system instruction"
                        />
                      </div>
                    </div>
                  </div>
                </details>

                {providers.map((provider) => (
                  <details
                    key={provider.providerId}
                    className="settingsCard settingsDetails"
                    open={providers.length === 1}
                  >
                    <summary className="settingsDetails__summary">
                      <div className="settingsRow settingsRow--stack">
                        <div className="settingsRow__text">
                          <div className="settingsRow__title">{provider.label}</div>
                          <div className="settingsRow__desc">{provider.models.length} model{provider.models.length === 1 ? '' : 's'}</div>
                        </div>
                      </div>
                    </summary>

                    <div className="settingsDetails__body">
	                      {provider.models.map((model) => {
	                        const s = props.modelUserSettings?.[model.id];
	                        const supportsStreaming = Boolean(model.parameters?.streaming);
	                        const supportsBackground = Boolean(model.parameters?.background);
	                        const supportsVerbosity = typeof model.defaults?.verbosity === 'string';
	                        const supportsSummary = model.provider === 'openai' && Boolean(model.effort);
	                        const includeInComposer = typeof s?.includeInComposer === 'boolean' ? s.includeInComposer : true;
	                        const streaming =
	                          typeof s?.streaming === 'boolean'
	                            ? s.streaming
	                            : supportsStreaming
	                              ? typeof model.defaults?.streaming === 'boolean'
	                                ? model.defaults.streaming
	                                : true
	                              : false;
	                        const background =
	                          typeof s?.background === 'boolean'
	                            ? s.background
	                            : supportsBackground
	                              ? typeof model.defaults?.background === 'boolean'
	                                ? model.defaults.background
	                                : false
	                              : false;
	                        const verbosity = (() => {
	                          const raw = typeof s?.verbosity === 'string' ? s.verbosity : String(model.defaults?.verbosity ?? 'medium');
	                          return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : 'medium';
	                        })();
	                        const reasoningSummary: ReasoningSummarySetting = (() => {
	                          if (!supportsSummary) return 'off';
	                          const raw = typeof s?.reasoningSummary === 'string' ? s.reasoningSummary : model.reasoningSummary ? 'auto' : 'off';
	                          return raw === 'auto' || raw === 'detailed' || raw === 'off' ? raw : model.reasoningSummary ? 'auto' : 'off';
	                        })();
	                        const supportsMaxTokens = model.provider === 'anthropic';
	                        const maxTokens = (() => {
	                          if (!supportsMaxTokens) return 0;
	                          const raw = s?.maxTokens;
	                          const n = typeof raw === 'number' ? raw : undefined;
	                          if (typeof n !== 'number' || !Number.isFinite(n)) return 4096;
	                          return Math.max(1, Math.min(200000, Math.floor(n)));
	                        })();
	                        const supportsAnthropicEffortControl = supportsAnthropicEffort(model);
	                        const anthropicEffortOptions = supportsAnthropicEffortControl ? getAnthropicEffortOptions(model) : [];
	                        const anthropicEffort = supportsAnthropicEffortControl
	                          ? normalizeAnthropicEffort(model, s?.anthropicEffort) ?? 'high'
	                          : 'high';

	                        const setSummary = (next: ReasoningSummarySetting) => {
	                          if (!supportsSummary) return;
	                          props.onUpdateModelUserSettings(model.id, { reasoningSummary: next });
	                        };

                        return (
                          <details key={model.id} className="settingsCard settingsDetails">
                            <summary className="settingsDetails__summary">
                              <div className="settingsRow settingsRow--stack">
                                <div className="settingsRow__text">
                                  <div className="settingsRow__title">{String(model.shortLabel ?? model.label ?? model.id).trim()}</div>
                                  <div className="settingsRow__desc">{model.apiModel}</div>
                                </div>
                              </div>
                            </summary>

                            <div className="settingsDetails__body">
                              <div className="settingsRow">
                                <div className="settingsRow__text">
                                  <div className="settingsRow__title">Show in composer</div>
                                  <div className="settingsRow__desc">Include this model in the message composer model picker.</div>
                                </div>
                                <div className="settingsRow__actions">
                                  <button
                                    className={`settingsToggle ${includeInComposer ? 'settingsToggle--on' : ''}`}
                                    type="button"
                                    aria-pressed={includeInComposer}
                                    onClick={() => props.onUpdateModelUserSettings(model.id, { includeInComposer: !includeInComposer })}
                                  >
                                    {includeInComposer ? 'On' : 'Off'}
                                  </button>
                                </div>
                              </div>

	                              <div className="settingsRow">
	                                <div className="settingsRow__text">
	                                  <div className="settingsRow__title">Streaming</div>
	                                  <div className="settingsRow__desc">Stream the response into the node as it arrives.</div>
	                                </div>
	                                <div className="settingsRow__actions">
                                  <button
                                    className={`settingsToggle ${streaming ? 'settingsToggle--on' : ''}`}
                                    type="button"
                                    aria-pressed={streaming}
                                    disabled={!supportsStreaming}
                                    onClick={() =>
                                      supportsStreaming
                                        ? props.onUpdateModelUserSettings(model.id, { streaming: !streaming })
                                        : undefined
                                    }
                                  >
                                    {streaming ? 'On' : 'Off'}
	                                  </button>
	                                </div>
	                              </div>

	                              <div className="settingsRow">
	                                <div className="settingsRow__text">
	                                  <div className="settingsRow__title">Background mode</div>
	                                  <div className="settingsRow__desc">Run requests asynchronously and resume after refresh. Enables Stop.</div>
	                                </div>
	                                <div className="settingsRow__actions">
	                                  <button
	                                    className={`settingsToggle ${background ? 'settingsToggle--on' : ''}`}
	                                    type="button"
	                                    aria-pressed={background}
	                                    disabled={!supportsBackground}
	                                    onClick={() =>
	                                      supportsBackground
	                                        ? props.onUpdateModelUserSettings(model.id, { background: !background })
	                                        : undefined
	                                    }
	                                  >
	                                    {background ? 'On' : 'Off'}
	                                  </button>
	                                </div>
	                              </div>

	                              {supportsMaxTokens ? (
	                                <div className="settingsRow">
	                                  <div className="settingsRow__text">
	                                    <div className="settingsRow__title">Max output tokens</div>
	                                    <div className="settingsRow__desc">Maximum length of the assistant reply.</div>
	                                  </div>
	                                  <div className="settingsRow__actions">
	                                    <input
	                                      className="settingsInput"
	                                      type="number"
	                                      min={1}
	                                      max={200000}
	                                      step={1}
	                                      value={maxTokens}
	                                      onChange={(e) => props.onUpdateModelUserSettings(model.id, { maxTokens: Number(e.currentTarget.value) })}
	                                      aria-label="Max output tokens"
	                                    />
	                                  </div>
	                                </div>
	                              ) : null}

                              {supportsAnthropicEffortControl ? (
                                <div className="settingsRow">
                                  <div className="settingsRow__text">
                                    <div className="settingsRow__title">Thinking effort</div>
                                    <div className="settingsRow__desc">
                                      Uses adaptive thinking mode and controls how much reasoning Claude spends before final output.
                                    </div>
                                  </div>
                                  <div className="settingsRow__actions">
                                    <select
                                      className="settingsSelect"
                                      value={anthropicEffort}
                                      onChange={(e) =>
                                        props.onUpdateModelUserSettings(model.id, {
                                          anthropicEffort: e.currentTarget.value as AnthropicEffortSetting,
                                        })
                                      }
                                      aria-label="Claude thinking effort"
                                    >
                                      {anthropicEffortOptions.map((effortOption) => (
                                        <option key={effortOption} value={effortOption}>
                                          {effortOption === 'max'
                                            ? 'Max'
                                            : effortOption.charAt(0).toUpperCase() + effortOption.slice(1)}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                              ) : null}

	                              <div className="settingsRow">
	                                <div className="settingsRow__text">
	                                  <div className="settingsRow__title">Verbosity</div>
	                                  <div className="settingsRow__desc">Controls response detail (if supported by the model).</div>
	                                </div>
                                <div className="settingsRow__actions">
                                  <select
                                    className="settingsSelect"
                                    value={supportsVerbosity ? verbosity : 'medium'}
                                    disabled={!supportsVerbosity}
                                    onChange={(e) =>
                                      props.onUpdateModelUserSettings(model.id, { verbosity: e.currentTarget.value as any })
                                    }
                                    aria-label="Model verbosity"
                                  >
                                    <option value="low">Low</option>
                                    <option value="medium">Medium</option>
                                    <option value="high">High</option>
                                  </select>
                                </div>
                              </div>

                              {supportsSummary ? (
                                <div className="settingsRow">
                                  <div className="settingsRow__text">
                                    <div className="settingsRow__title">Thinking summary</div>
                                    <div className="settingsRow__desc">Request a reasoning summary alongside the answer.</div>
                                  </div>
                                  <div className="settingsRow__actions">
                                    <button
                                      className={`settingsToggle ${reasoningSummary === 'auto' ? 'settingsToggle--on' : ''}`}
                                      type="button"
                                      aria-pressed={reasoningSummary === 'auto'}
                                      onClick={() => setSummary('auto')}
                                    >
                                      Auto
                                    </button>
                                    <button
                                      className={`settingsToggle ${reasoningSummary === 'detailed' ? 'settingsToggle--on' : ''}`}
                                      type="button"
                                      aria-pressed={reasoningSummary === 'detailed'}
                                      onClick={() => setSummary('detailed')}
                                    >
                                      Detailed
                                    </button>
                                    <button
                                      className={`settingsToggle ${reasoningSummary === 'off' ? 'settingsToggle--on' : ''}`}
                                      type="button"
                                      aria-pressed={reasoningSummary === 'off'}
                                      onClick={() => setSummary('off')}
                                    >
                                      Off
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </details>
                ))}
              </div>
            ) : null}

            {props.activePanel === 'debug' ? (
              <div className="settingsPanel">
                <div className="settingsPanel__header">
                  <div className="settingsPanel__title">Debug</div>
                  <div className="settingsPanel__subtitle">Toggle overlays and stress tools.</div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Debug HUD</div>
                      <div className="settingsRow__desc">Show the top-right zoom/camera readout.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.debugHudVisible ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.debugHudVisible}
                        onClick={props.onToggleDebugHudVisible}
                      >
                        {props.debugHudVisible ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Send all</div>
                      <div className="settingsRow__desc">Enable multi-model send controls in the composer.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.sendAllEnabled ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.sendAllEnabled}
                        onClick={props.onToggleSendAllEnabled}
                      >
                        {props.sendAllEnabled ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>

                  {props.sendAllEnabled ? (
                    <div className="settingsSendAllList" role="list" aria-label="Send all model list">
                      {(props.models ?? []).map((model) => {
                        const modelId = String(model.id ?? '').trim();
                        if (!modelId) return null;
                        const checked = (props.sendAllModelIds ?? []).includes(modelId);
                        const shortLabel = String(model.shortLabel ?? model.label ?? modelId).trim();
                        const provider =
                          model.provider === 'openai'
                            ? 'OpenAI'
                            : model.provider === 'gemini'
                              ? 'Gemini'
                              : model.provider === 'anthropic'
                                ? 'Anthropic'
                                : model.provider === 'xai'
                                  ? 'xAI'
                                  : String(model.provider ?? '').trim() || 'Provider';
                        return (
                          <label key={modelId} className="settingsSendAllList__item" role="listitem">
                            <input
                              className="settingsSendAllList__checkbox"
                              type="checkbox"
                              checked={checked}
                              onChange={() => props.onToggleSendAllModelId(modelId)}
                            />
                            <span className="settingsSendAllList__meta">
                              <span className="settingsSendAllList__title">{shortLabel}</span>
                              <span className="settingsSendAllList__desc">{provider} • {model.apiModel}</span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Edit all text nodes</div>
                      <div className="settingsRow__desc">
                        When off, only note/edit nodes (spawned from the bottom-right +Text button) can be edited by double-click.
                      </div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.allowEditingAllTextNodes ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.allowEditingAllTextNodes}
                        onClick={props.onToggleAllowEditingAllTextNodes}
                      >
                        {props.allowEditingAllTextNodes ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Draw-to-spawn note/edit nodes</div>
                      <div className="settingsRow__desc">When on, the bottom-right +Text button lets you drag out the node rectangle (Esc cancels).</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.spawnEditNodeByDraw ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.spawnEditNodeByDraw}
                        onClick={props.onToggleSpawnEditNodeByDraw}
                      >
                        {props.spawnEditNodeByDraw ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Draw-to-spawn ink nodes</div>
                      <div className="settingsRow__desc">When on, the bottom-right Ink button lets you drag out the node rectangle (Esc cancels).</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.spawnInkNodeByDraw ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.spawnInkNodeByDraw}
                        onClick={props.onToggleSpawnInkNodeByDraw}
                      >
                        {props.spawnInkNodeByDraw ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Ink send crop</div>
                      <div className="settingsRow__desc">Crop empty margins around strokes when sending ink nodes.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.inkSendCropEnabled ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.inkSendCropEnabled}
                        onClick={props.onToggleInkSendCropEnabled}
                      >
                        {props.inkSendCropEnabled ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>

                  <div className="settingsSlider">
                    <div className="settingsSlider__labelRow">
                      <span>Crop padding</span>
                      <span>{Math.round(props.inkSendCropPaddingPx)}px</span>
                    </div>
                    <input
                      className="settingsSlider__range"
                      type="range"
                      min={0}
                      max={200}
                      step={4}
                      value={Math.round(props.inkSendCropPaddingPx)}
                      onChange={(e) => props.onChangeInkSendCropPaddingPx(Number(e.currentTarget.value))}
                    />
                  </div>

                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Ink send scaling</div>
                      <div className="settingsRow__desc">When off, the image will not be downscaled and may fail if it exceeds the limits below.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.inkSendDownscaleEnabled ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.inkSendDownscaleEnabled}
                        onClick={props.onToggleInkSendDownscaleEnabled}
                      >
                        {props.inkSendDownscaleEnabled ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>

                  <div className="settingsSlider">
                    <div className="settingsSlider__labelRow">
                      <span>Max pixels</span>
                      <span>{Math.round(props.inkSendMaxPixels).toLocaleString()}</span>
                    </div>
                    <input
                      className="settingsSlider__range"
                      type="range"
                      min={200000}
                      max={24000000}
                      step={250000}
                      value={Math.round(props.inkSendMaxPixels)}
                      onChange={(e) => props.onChangeInkSendMaxPixels(Number(e.currentTarget.value))}
                    />
                  </div>

                  <div className="settingsSlider">
                    <div className="settingsSlider__labelRow">
                      <span>Max dimension</span>
                      <span>{Math.round(props.inkSendMaxDimPx)}px</span>
                    </div>
                    <input
                      className="settingsSlider__range"
                      type="range"
                      min={512}
                      max={8192}
                      step={256}
                      value={Math.round(props.inkSendMaxDimPx)}
                      onChange={(e) => props.onChangeInkSendMaxDimPx(Number(e.currentTarget.value))}
                    />
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Canonicalize layout</div>
                      <div className="settingsRow__desc">Apply a deterministic tree layout to this chat.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <select
                        className="settingsSelect"
                        value={props.canonicalizeLayoutAlgorithm}
                        onChange={(e) =>
                          props.onChangeCanonicalizeLayoutAlgorithm(e.currentTarget.value as CanonicalizeLayoutAlgorithm)
                        }
                        aria-label="Canonicalize layout algorithm"
                      >
                        <option value="layered">Layered</option>
                        <option value="reingold-tilford">Reingold-Tilford</option>
                      </select>
                      <button className="settingsBtn settingsBtn--primary" type="button" onClick={props.onCanonicalizeLayout}>
                        Apply
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Auto-resize</div>
                      <div className="settingsRow__desc">
                        Resize all text nodes in this chat to fit their content (clamped to the spawn min/max).
                      </div>
                    </div>
                    <div className="settingsRow__actions">
                      <button className="settingsBtn" type="button" onClick={props.onAutoResizeAllTextNodes}>
                        Auto-resize
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow settingsRow--stack">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Spawn N nodes</div>
                      <div className="settingsRow__desc">Stress test: spawn between 1 and 500 nodes.</div>
                    </div>
                    <div className="settingsRow__actions settingsRow__actions--grow">
                      <input
                        className="settingsInput"
                        type="number"
                        min={1}
                        max={500}
                        step={1}
                        value={props.spawnCount}
                        onChange={(e) => props.onChangeSpawnCount(Number(e.currentTarget.value))}
                        aria-label="Spawn count"
                      />
                      <button className="settingsBtn" type="button" onClick={props.onSpawnNodes}>
                        Spawn
                      </button>
                      <button className="settingsBtn" type="button" onClick={props.onClearStressNodes}>
                        Clear
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {props.activePanel === 'data' ? (
              <div className="settingsPanel">
                <div className="settingsPanel__header">
                  <div className="settingsPanel__title">Data</div>
                  <div className="settingsPanel__subtitle">Import a backup or export everything. Per-chat export is available from the ⋮ menu in the sidebar.</div>
                </div>

	                <div className="settingsCard">
	                  <div className="settingsRow">
	                    <div className="settingsRow__text">
	                      <div className="settingsRow__title">Import</div>
	                      <div className="settingsRow__desc">Load a .graphchatv1.json file (single chat or export-all).</div>
	                    </div>
	                    <div className="settingsRow__actions">
	                      <button className="settingsBtn" type="button" onClick={props.onRequestImportChat}>
	                        Import…
	                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Export all</div>
                      <div className="settingsRow__desc">Download every chat (including attachments, raw payloads, and backgrounds).</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button className="settingsBtn" type="button" onClick={props.onExportAllChats}>
                        Export all…
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow settingsRow--stack">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Storage location</div>
                      <div className="settingsRow__desc">
                        Chats, workspace snapshots, attachments, and payload logs are saved here.
                      </div>
                      <div className="settingsPathValue" title={props.storagePath ?? ''}>
                        {props.storagePath ?? 'Available in Electron desktop mode.'}
                      </div>
                      {!props.storagePathIsDefault && props.storageDefaultPath ? (
                        <div className="settingsRow__desc">
                          Default: <span className="settingsPathInline">{props.storageDefaultPath}</span>
                        </div>
                      ) : null}
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className="settingsBtn"
                        type="button"
                        disabled={!props.canManageStorageLocation}
                        onClick={props.onChooseStorageLocation}
                      >
                        Choose location…
                      </button>
                      <button
                        className="settingsBtn"
                        type="button"
                        disabled={!props.canManageStorageLocation || props.storagePathIsDefault}
                        onClick={props.onResetStorageLocation}
                      >
                        Reset default
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Open storage folder</div>
                      <div className="settingsRow__desc">
                        {props.canOpenStorageFolder
                          ? 'Open the desktop storage location on disk.'
                          : 'Available in Electron desktop mode.'}
                      </div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className="settingsBtn"
                        type="button"
                        disabled={!props.canOpenStorageFolder}
                        onClick={props.onOpenStorageFolder}
                      >
                        Open folder
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {props.activePanel === 'reset' ? (
              <div className="settingsPanel">
                <div className="settingsPanel__header">
                  <div className="settingsPanel__title">Reset or Clear Data</div>
                  <div className="settingsPanel__subtitle">Delete chats and clear the background library.</div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Delete chat folders on chat delete</div>
                      <div className="settingsRow__desc">
                        When enabled, removing chats also deletes their on-disk chat folders.
                      </div>
                    </div>
                    <div className="settingsRow__actions">
                      <button
                        className={`settingsToggle ${props.cleanupChatFoldersOnDelete ? 'settingsToggle--on' : ''}`}
                        type="button"
                        aria-pressed={props.cleanupChatFoldersOnDelete}
                        onClick={props.onToggleCleanupChatFoldersOnDelete}
                      >
                        {props.cleanupChatFoldersOnDelete ? 'On' : 'Off'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Reset to defaults</div>
                      <div className="settingsRow__desc">Clears the background library and deletes all chats.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button className="settingsBtn settingsBtn--danger" type="button" onClick={props.onResetToDefaults}>
                        Reset
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            </div>
          </div>
        </div>

        <button className="settingsModal__close" type="button" onClick={props.onClose} aria-label="Close settings">
          ×
        </button>
      </div>
    </div>
  );
}
