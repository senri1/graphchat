import React, { useEffect, useMemo } from 'react';
import { FONT_FAMILY_OPTIONS, type FontFamilyKey } from '../ui/typography';

export type SettingsPanelId = 'appearance' | 'debug' | 'reset';

type PanelDef = { id: SettingsPanelId; title: string; description: string };

type Props = {
  open: boolean;
  activePanel: SettingsPanelId;
  onChangePanel: (panel: SettingsPanelId) => void;
  onClose: () => void;

  backgroundEnabled: boolean;
  onImportBackground: () => void;
  onClearBackground: () => void;
  onImportPdf: () => void;

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
  spawnCount: number;
  onChangeSpawnCount: (next: number) => void;
  onSpawnNodes: () => void;
  onClearStressNodes: () => void;

  onResetToDefaults: () => void;
};

export default function SettingsModal(props: Props) {
  const open = props.open;
  const onClose = props.onClose;

  const panels: PanelDef[] = useMemo(
    () => [
      {
        id: 'appearance',
        title: 'Appearance & Personalization',
        description: 'Background, typography, and glass nodes',
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
      <div className="settingsModal" onMouseDown={(e) => e.stopPropagation()}>
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

                <div className="settingsCard">
                  <div className="settingsRow">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">PDF</div>
                      <div className="settingsRow__desc">Import a PDF node into the canvas.</div>
                    </div>
                    <div className="settingsRow__actions">
                      <button className="settingsBtn" type="button" onClick={props.onImportPdf}>
                        Import PDF
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settingsCard">
                  <div className="settingsRow settingsRow--stack">
                    <div className="settingsRow__text">
                      <div className="settingsRow__title">Typography</div>
                      <div className="settingsRow__desc">Adjust fonts and sizes for composer, nodes, and sidebar.</div>
                    </div>
                  </div>

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

        <button className="settingsModal__close" type="button" onClick={props.onClose} aria-label="Close settings">
          ×
        </button>
      </div>
    </div>
  );
}
