// Scenario tab management — up to 5 scenarios, localStorage persistence

import { MAX_SCENARIOS, SCENARIO_COLORS, SCENARIO_NAMES, DEFAULT_STATE } from '../data/parameters.js';

const LS_KEY = 'freedomgap_scenarios_v2';

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

export function defaultScenario(id = 0) {
  return {
    id,
    name: SCENARIO_NAMES[id] ?? `Scenario ${id + 1}`,
    color: SCENARIO_COLORS[id] ?? '#64748b',
    visible: true,
    showSequencing: false,
    state: deepClone(DEFAULT_STATE),
  };
}

export function loadScenarios() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return [defaultScenario(0)];
}

export function saveScenarios(scenarios) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(scenarios));
  } catch (_) {}
}

export function exportJSON(scenarios) {
  const blob = new Blob([JSON.stringify(scenarios, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'freedomgap-scenarios.json';
  a.click();
  URL.revokeObjectURL(url);
}

export function importJSON(onImport) {
  const inp   = document.createElement('input');
  inp.type    = 'file';
  inp.accept  = '.json';
  inp.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (Array.isArray(data)) onImport(data.slice(0, MAX_SCENARIOS));
      } catch (_) { alert('Invalid JSON file.'); }
    };
    reader.readAsText(file);
  };
  inp.click();
}

/**
 * Render scenario tabs and wire up add/remove/visibility controls.
 * @param {Array}    scenarios       - Mutable array of scenario objects
 * @param {number}   activeId        - Currently active scenario id
 * @param {Function} onSelect        - (id) => void — switch to scenario
 * @param {Function} onAdd           - () => void — add new scenario
 * @param {Function} onRemove        - (id) => void — remove scenario
 * @param {Function} onVisibility    - (id, visible) => void — toggle overlay visibility
 * @param {Function} onSequencing    - (id, show) => void — toggle sequencing overlay
 */
export function renderScenarioTabs(
  scenarios, activeId,
  onSelect, onAdd, onRemove, onVisibility, onSequencing
) {
  const container = document.getElementById('scenarioTabs');
  if (!container) return;
  container.innerHTML = '';

  for (const sc of scenarios) {
    const tab = document.createElement('div');
    tab.className = `scenario-tab${sc.id === activeId ? ' active' : ''}`;
    tab.style.setProperty('--sc-color', sc.color);

    // Colour dot
    const dot = document.createElement('span');
    dot.className = 'sc-dot';
    dot.style.background = sc.color;
    tab.appendChild(dot);

    // Name (editable on double-click)
    const nameSpan = document.createElement('span');
    nameSpan.className = 'sc-name';
    nameSpan.textContent = sc.name;
    nameSpan.title = 'Double-click to rename';
    nameSpan.addEventListener('dblclick', () => {
      const inp = document.createElement('input');
      inp.value = sc.name;
      inp.className = 'sc-rename';
      inp.style.cssText = 'width:7rem;font-size:.8rem;border:none;border-bottom:1px solid currentColor;background:transparent;outline:none;';
      nameSpan.replaceWith(inp);
      inp.focus();
      inp.select();
      const finish = () => {
        sc.name = inp.value.trim() || sc.name;
        saveScenarios(scenarios);
        renderScenarioTabs(scenarios, activeId, onSelect, onAdd, onRemove, onVisibility, onSequencing);
      };
      inp.addEventListener('blur', finish);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') finish(); });
    });
    tab.appendChild(nameSpan);

    // Click to activate
    tab.addEventListener('click', e => {
      if (e.target.closest('.sc-remove, .sc-vis, input')) return;
      onSelect(sc.id);
    });

    // Visibility toggle (eye icon)
    const visBtn = document.createElement('button');
    visBtn.className = 'sc-vis';
    visBtn.title = sc.visible ? 'Hide from chart' : 'Show on chart';
    visBtn.textContent = sc.visible ? '👁' : '○';
    visBtn.addEventListener('click', e => { e.stopPropagation(); onVisibility(sc.id, !sc.visible); });
    tab.appendChild(visBtn);

    // Remove (only if more than one scenario)
    if (scenarios.length > 1) {
      const rmBtn = document.createElement('button');
      rmBtn.className = 'sc-remove';
      rmBtn.title = 'Remove scenario';
      rmBtn.textContent = '×';
      rmBtn.addEventListener('click', e => { e.stopPropagation(); onRemove(sc.id); });
      tab.appendChild(rmBtn);
    }

    container.appendChild(tab);
  }

  // Add button
  if (scenarios.length < MAX_SCENARIOS) {
    const addBtn = document.createElement('button');
    addBtn.className = 'scenario-add';
    addBtn.textContent = '+ Add scenario';
    addBtn.addEventListener('click', onAdd);
    container.appendChild(addBtn);
  }
}

/**
 * Render the sequencing toggle button for the active scenario.
 */
export function renderSequencingToggle(scenario, onToggle) {
  const container = document.getElementById('sequencingToggle');
  if (!container) return;
  container.innerHTML = '';

  const btn = document.createElement('button');
  btn.className = `seq-btn${scenario.showSequencing ? ' active' : ''}`;
  btn.textContent = scenario.showSequencing ? 'Hide stress test' : 'Show stress test';
  btn.title = 'Sequencing risk: −25% in year 1 of retirement';
  btn.addEventListener('click', () => onToggle(scenario.id, !scenario.showSequencing));
  container.appendChild(btn);
}
