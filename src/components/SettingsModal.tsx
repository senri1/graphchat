import React, { useEffect, useMemo } from 'react';
import { FONT_FAMILY_OPTIONS, type FontFamilyKey } from '../ui/typography';
import type { ModelInfo } from '../llm/registry';
import type { ModelUserSettings, ModelUserSettingsById, ReasoningSummarySetting } from '../llm/modelUserSettings';

export type SettingsPanelId = 'appearance' | 'models' | 'debug' | 'reset';

type PanelDef = { id: SettingsPanelId; title: string; description: string };

type Props = {
  open: boolean;
  activePanel: SettingsPanelId;
  onChangePanel: (panel: SettingsPanelId) => void;
  onClose: () => void;

  models: ModelInfo[];
  modelUserSettings: ModelUserSettingsById;
  onUpdateModelUserSettings: (modelId: string, patch: Partial<ModelUserSettings>) => void;

  backgroundEnabled: boolean;
  onImportBackground: () => void;
  onClearBackground: () => void;

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
  allowEditingAllTextNodes: boolean;
  onToggleAllowEditingAllTextNodes: () => void;
  spawnCount: number;
  onChangeSpawnCount: (next: number) => void;
  onSpawnNodes: () => void;
  onClearStressNodes: () => void;

  onResetToDefaults: () => void;
};

export default function SettingsModal(props: Props) {
  const open = props.open;
  const onClose = props.onClose;

  const providers = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of props.models ?? []) {
      if (!m || typeof m.id !== 'string') continue;
      const key = typeof (m as any).provider === 'string' ? String((m as any).provider) : 'unknown';
      const list = byProvider.get(key) ?? [];
      list.push(m);
      byProvider.set(key, list);
    }
    const labelFor = (p: string) => (p === 'openai' ? 'OpenAI' : p === 'gemini' ? 'Gemini' : p);
    return Array.from(byProvider.entries())
      .map(([providerId, models]) => ({
        providerId,
        label: labelFor(providerId),
        models: models.slice().sort((a, b) => String(a.label ?? a.id).localeCompare(String(b.label ?? b.id))),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [props.models]);

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
        id: 'reset',
        title: 'Reset or Clear Data',
        description: 'Remove background and delete chats',
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
                  <div className="settingsPanel__subtitle">Import backgrounds and tune typography and glass nodes.</div>
                </div>

	                <div className="settingsCard">
	                  <div className="settingsRow">
	                    <div className="settingsRow__text">
	                      <div className="settingsRow__title">Background</div>
	                      <div className="settingsRow__desc">Set or clear the canvas background image.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button className="settingsBtn" type="button" onClick={props.onImportBackground}>
                        Import background
                      </button>
                      <button
                        className="settingsBtn"
                        type="button"
                        disabled={!props.backgroundEnabled}
                        onClick={props.onClearBackground}
                      >
                        Clear background
                      </button>
                    </div>
	                  </div>
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

            {props.activePanel === 'reset' ? (
              <div className="settingsPanel">
                <div className="settingsPanel__header">
                  <div className="settingsPanel__title">Reset or Clear Data</div>
                  <div className="settingsPanel__subtitle">Delete chats and remove background.</div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Reset to defaults</div>
                      <div className="settingsRow__desc">Removes the background and deletes all chats.</div>
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
