import PackIcon from '@shared/components/icons/PackIcon.jsx';
import MetricSelect from '@features/annotations/components/shared/MetricSelect.jsx';

const SPEEDS = [1, 2, 4, 8, 16, 30, 60];
const SPEED_OPTIONS = SPEEDS.map((value) => ({
  value,
  label: `${value} ${value === 1 ? 'conformero' : 'conformeros'}/s`,
}));

export default function BioEmuControls({
  frameCount,
  currentIndex,
  playing,
  speed,
  loop,
  controller,
  disabled = false,
  onSpeedChange,
  onLoopChange,
}) {
  const available = Number.isInteger(frameCount) && frameCount > 0 && Boolean(controller) && !disabled;
  const atFirst = currentIndex === 0;
  const atLast = Number.isInteger(frameCount) && currentIndex === frameCount - 1;
  return (
    <div class="bioemu-controls" aria-label="Controles de conformeros">
      <div class="bioemu-playback-row">
        <div class="bioemu-playback-actions" role="group" aria-label="Navegación entre conformeros">
          <button type="button" class="bioemu-icon-button" onClick={() => controller?.reset()} disabled={!available || atFirst} aria-label="Ir al primer conformero" title="Ir al primer conformero">
            <PackIcon name="skip-back" kind="ui" />
          </button>
          <button type="button" class="bioemu-icon-button" onClick={() => controller?.step(-1)} disabled={!available || frameCount < 2 || (atFirst && !loop)} aria-label="Conformero anterior" title="Conformero anterior">
            <PackIcon name="chevron-left" kind="ui" />
          </button>
          <button type="button" class="bioemu-icon-button bioemu-play-toggle" onClick={() => controller?.toggle()} disabled={!available || frameCount < 2 || (atLast && !loop && !playing)} aria-label={playing ? 'Pausar reproducción' : 'Iniciar reproducción'} aria-pressed={playing}>
            <PackIcon name={playing ? 'pause' : 'play'} kind="ui" />
          </button>
          <button type="button" class="bioemu-icon-button" onClick={() => controller?.step(1)} disabled={!available || frameCount < 2 || (atLast && !loop)} aria-label="Conformero siguiente" title="Conformero siguiente">
            <PackIcon name="chevron-right" kind="ui" />
          </button>
          <button type="button" class="bioemu-icon-button bioemu-skip-forward" onClick={() => controller?.setIndex(frameCount - 1)} disabled={!available || atLast} aria-label="Ir al último conformero" title="Ir al último conformero">
            <PackIcon name="skip-forward" kind="ui" />
          </button>
        </div>
      </div>
      <label class="bioemu-slider-row">
        <span class="bioemu-visually-hidden">Seleccionar conformero</span>
        <input
          type="range"
          min="0"
          max={Math.max(0, (frameCount ?? 0) - 1)}
          step="1"
          value={available ? currentIndex : 0}
          disabled={!available}
          aria-label={available ? `Conformero ${currentIndex + 1} de ${frameCount}` : 'Conformero no disponible'}
          onInput={(event) => controller?.setIndex(Number(event.currentTarget.value))}
        />
      </label>
      <div class="bioemu-options-row">
        <div class="bioemu-speed-control">
          <span>Velocidad visual</span>
          <MetricSelect
            id="bioemu-speed"
            label="Velocidad de reproducción visual"
            options={SPEED_OPTIONS}
            value={speed}
            disabled={!available || frameCount < 2}
            onChange={(value) => onSpeedChange?.(Number(value))}
          />
        </div>
        <button
          type="button"
          class={`bioemu-loop-button ${loop ? 'is-active' : ''}`}
          aria-pressed={loop}
          aria-label={loop ? 'Desactivar repetición en bucle' : 'Activar repetición en bucle'}
          title={loop ? 'Desactivar repetición en bucle' : 'Activar repetición en bucle'}
          disabled={!available || frameCount < 2}
          onClick={() => onLoopChange?.(!loop)}
        >
          <PackIcon name="rotate-cw" kind="ui" />
          <span>Repetir</span>
        </button>
      </div>
    </div>
  );
}
