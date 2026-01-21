import React, { useEffect, useMemo } from 'react';

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

  glassNodesEnabled: boolean;
  onToggleGlassNodes: () => void;
  glassBlurBackend: 'webgl' | 'canvas';
  onChangeGlassBlurBackend: (next: 'webgl' | 'canvas') => void;
  glassBlurPx: number;
  onChangeGlassBlurPx: (next: number) => void;
  glassSaturationPct: number;
  onChangeGlassSaturationPct: (next: number) => void;
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
        description: 'Background and glass node settings',
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
                  <div className="settingsPanel__subtitle">Import backgrounds and tune glass nodes.</div>
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
