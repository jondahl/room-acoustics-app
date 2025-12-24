import React, { useState, useMemo, useEffect } from 'react';

const SPEED_OF_SOUND = 1130; // ft/s

// ============== ACOUSTIC CALCULATIONS ==============

const calcModeFreq = (n, m, l, length, width, height) => {
  const termL = n > 0 ? (n / length) ** 2 : 0;
  const termW = m > 0 ? (m / width) ** 2 : 0;
  const termH = l > 0 ? (l / height) ** 2 : 0;
  if (termL + termW + termH === 0) return 0;
  return (SPEED_OF_SOUND / 2) * Math.sqrt(termL + termW + termH);
};

const getModeType = (n, m, l) => {
  const nonZero = [n, m, l].filter(x => x > 0).length;
  if (nonZero === 1) return { type: 'axial', level: 0 };
  if (nonZero === 2) return { type: 'tangential', level: -3 };
  return { type: 'oblique', level: -6 };
};

const generateModes = (length, width, height, maxFreq, maxOrder = 6) => {
  const modes = [];
  for (let n = 0; n <= maxOrder; n++) {
    for (let m = 0; m <= maxOrder; m++) {
      for (let l = 0; l <= maxOrder; l++) {
        if (n === 0 && m === 0 && l === 0) continue;
        const freq = calcModeFreq(n, m, l, length, width, height);
        if (freq > 0 && freq <= maxFreq) {
          const { type, level } = getModeType(n, m, l);
          modes.push({ n, m, l, freq, type, level });
        }
      }
    }
  }
  return modes.sort((a, b) => a.freq - b.freq);
};

const calcPressureAtPosition = (x, y, z, mode, room, wallOpenings) => {
  const { n, m, l } = mode;
  const { length, width, height } = room;

  let pX = n > 0 ? Math.cos(n * Math.PI * x / length) : 1;
  let pY = m > 0 ? Math.cos(m * Math.PI * y / width) : 1;
  let pZ = l > 0 ? Math.cos(l * Math.PI * z / height) : 1;

  let rawPressure = Math.abs(pX * pY * pZ);

  // Calculate mode strength based on wall openings
  // Mode requires reflections from both walls - multiplicative
  let modeStrength = 1.0;
  if (m > 0) {
    modeStrength *= (1 - wallOpenings.left / 100) * (1 - wallOpenings.right / 100);
  }
  if (n > 0) {
    modeStrength *= (1 - wallOpenings.front / 100) * (1 - wallOpenings.rear / 100);
  }

  // Push pressure toward neutral (0.5) as mode weakens
  // Full strength: peaks stay at 1, nulls stay at 0
  // No mode: everything becomes 0.5 (neutral)
  const pressure = 0.5 + (rawPressure - 0.5) * modeStrength;

  return pressure;
};

const calcDipoleExcitation = (speaker, mode, room) => {
  const { x, y, z, orientation } = speaker;
  const { length, width, height } = room;
  const { n, m, l, freq } = mode;
  
  // Base pressure at position
  let pX = n > 0 ? Math.cos(n * Math.PI * x / length) : 1;
  let pY = m > 0 ? Math.cos(m * Math.PI * y / width) : 1;
  let pZ = l > 0 ? Math.cos(l * Math.PI * z / height) : 1;
  let basePressure = Math.abs(pX * pY * pZ);
  
  // Dipole cancellation based on orientation
  const wavelength = SPEED_OF_SOUND / freq;
  const dipoleDepth = 1.5; // ft, approximate
  const phaseDiff = (dipoleDepth / wavelength) * 360;
  
  let cancellationFactor = 1;
  
  // orientation: 0 = facing listener (along length), 90 = facing sideways
  const orientRad = (orientation || 0) * Math.PI / 180;
  
  // Length modes affected when facing along length
  if (n > 0) {
    const lengthEffect = Math.abs(Math.cos(orientRad));
    cancellationFactor *= 1 - lengthEffect * (1 - Math.abs(Math.cos(phaseDiff * Math.PI / 360)));
  }
  
  // Width modes affected when facing sideways
  if (m > 0) {
    const widthEffect = Math.abs(Math.sin(orientRad));
    cancellationFactor *= 1 - widthEffect * (1 - Math.abs(Math.cos(phaseDiff * Math.PI / 360)));
  }
  
  // Height modes less affected
  if (l > 0) {
    cancellationFactor *= 0.9;
  }
  
  return basePressure * cancellationFactor;
};

const calcSBIR = (speaker, room) => {
  const { x, y, z } = speaker;
  const { length, width, height } = room;
  
  const distances = [
    { boundary: 'Front wall', distance: x },
    { boundary: 'Rear wall', distance: length - x },
    { boundary: 'Left wall', distance: y },
    { boundary: 'Right wall', distance: width - y },
    { boundary: 'Floor', distance: z },
    { boundary: 'Ceiling', distance: height - z },
  ];
  
  return distances
    .filter(d => d.distance > 0.1 && d.distance < 15)
    .map(d => ({
      ...d,
      freq: SPEED_OF_SOUND / (2 * d.distance),
    }))
    .sort((a, b) => a.freq - b.freq);
};

const calcBoundaryGain = (speaker, room, wallOpenings) => {
  const { x, y, z, type } = speaker;
  const { length, width, height } = room;
  const threshold = 2;
  
  let gain = 0;
  const isMonopole = type !== 'Large Dipole';
  const gainPerBoundary = isMonopole ? 3 : 1.5;
  
  if (z < threshold) gain += gainPerBoundary; // floor
  if (height - z < threshold) gain += gainPerBoundary; // ceiling
  if (x < threshold) gain += gainPerBoundary * (1 - wallOpenings.front / 100);
  if (length - x < threshold) gain += gainPerBoundary * (1 - wallOpenings.rear / 100);
  if (y < threshold) gain += gainPerBoundary * (1 - wallOpenings.left / 100);
  if (width - y < threshold) gain += gainPerBoundary * (1 - wallOpenings.right / 100);
  
  return gain;
};

const calcSchroederFreq = (volume, rt60 = 0.4) => {
  const volumeM3 = volume * 0.0283168; // ft³ to m³
  return 2000 * Math.sqrt(rt60 / volumeM3);
};

// ============== SUBWOOFER OPTIMIZER ==============

// Pressure with sign preserved (for phase cancellation calculations)
const calcPressureWithSign = (pos, mode, room) => {
  const pX = mode.n > 0 ? Math.cos(mode.n * Math.PI * pos.x / room.length) : 1;
  const pY = mode.m > 0 ? Math.cos(mode.m * Math.PI * pos.y / room.width) : 1;
  const pZ = mode.l > 0 ? Math.cos(mode.l * Math.PI * pos.z / room.height) : 1;
  return pX * pY * pZ; // Signed value for phase relationships
};

// Calculate predicted frequency response for a subwoofer configuration
const calcPredictedFR = (subPositions, modes, room, listener, freqRange = [20, 120]) => {
  const frequencies = [];
  for (let f = freqRange[0]; f <= freqRange[1]; f += 2) frequencies.push(f);

  return frequencies.map(freq => {
    // Find modes that contribute at this frequency (within modal bandwidth)
    const bandwidth = freq / 8; // Q ~ 8 for room modes
    const nearbyModes = modes.filter(m => Math.abs(m.freq - freq) < bandwidth);

    // Calculate net contribution from all modes
    let totalPressure = 0;
    nearbyModes.forEach(mode => {
      // How much the LP couples to this mode
      const lpCoupling = calcPressureWithSign(listener, mode, room);

      // Sum sub excitations (with sign for phase cancellation)
      const netSubExcitation = subPositions.reduce((sum, sub) => {
        return sum + calcPressureWithSign(sub, mode, room);
      }, 0);

      // Weight by mode type (axial modes are stronger)
      const typeWeight = mode.type === 'axial' ? 1.0 : mode.type === 'tangential' ? 0.5 : 0.25;

      // Mode contribution = sub excitation × LP coupling × type weight
      const modeContribution = netSubExcitation * lpCoupling * typeWeight;
      totalPressure += modeContribution;
    });

    // Add baseline (direct sound contribution, prevents -Infinity dB)
    const baseline = 0.5;
    totalPressure += baseline;

    // Convert to dB (relative)
    const dB = 20 * Math.log10(Math.abs(totalPressure));
    return { freq, dB, pressure: totalPressure };
  });
};

// Standard deviation helper
const standardDeviation = (arr) => {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, val) => sum + (val - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
};

// Score a subwoofer configuration based on FR flatness
const scoreSubConfig = (subPositions, modes, room, listener) => {
  const fr = calcPredictedFR(subPositions, modes, room, listener);
  const dBValues = fr.map(r => r.dB);

  // Primary metrics: FR flatness
  const peakToPeak = Math.max(...dBValues) - Math.min(...dBValues);
  const stdDev = standardDeviation(dBValues);

  // Score: lower peak-to-peak = better (scaled so ±15dB → ~50 score)
  const flatnessScore = Math.max(0, 100 - peakToPeak * 3);

  // Calculate mode-by-mode details for expanded view
  const modeDetails = modes.filter(m => m.freq <= 120).map(mode => {
    const lpCoupling = calcPressureWithSign(listener, mode, room);
    const netSubExcitation = subPositions.reduce((sum, sub) => {
      return sum + calcPressureWithSign(sub, mode, room);
    }, 0);
    const effectiveImpact = Math.abs(netSubExcitation * lpCoupling);

    return {
      mode,
      lpPressure: Math.abs(lpCoupling),
      netExcitation: netSubExcitation,
      absExcitation: Math.abs(netSubExcitation),
      effectiveImpact,
      isCancelled: Math.abs(netSubExcitation) < 0.2 && subPositions.length > 1,
    };
  });

  return {
    overall: flatnessScore,
    peakToPeak,
    stdDev,
    fr,
    modeDetails,
  };
};

// Predefined placement strategies
const PLACEMENT_STRATEGIES = {
  // Single sub configurations
  'single-corner-fl': {
    name: 'Front Left Corner',
    subs: 1,
    description: 'Maximum boundary gain, excites all modes',
    getPositions: (room) => [{ x: 0.5, y: 0.5, z: 0 }],
  },
  'single-corner-fr': {
    name: 'Front Right Corner',
    subs: 1,
    description: 'Maximum boundary gain, excites all modes',
    getPositions: (room) => [{ x: 0.5, y: room.width - 0.5, z: 0 }],
  },
  'single-midwall-front': {
    name: 'Front Wall Center',
    subs: 1,
    description: 'At null for odd width modes (0,1,0), (0,3,0)...',
    getPositions: (room) => [{ x: 0.5, y: room.width / 2, z: 0 }],
  },
  'single-midwall-side': {
    name: 'Left Wall Center',
    subs: 1,
    description: 'At null for odd length modes (1,0,0), (3,0,0)...',
    getPositions: (room) => [{ x: room.length / 2, y: 0.5, z: 0 }],
  },

  // Dual sub configurations
  'dual-front-corners': {
    name: 'Dual Front Corners',
    subs: 2,
    description: 'Cancels odd width modes via phase opposition',
    getPositions: (room) => [
      { x: 0.5, y: 0.5, z: 0 },
      { x: 0.5, y: room.width - 0.5, z: 0 },
    ],
  },
  'dual-opposite-corners': {
    name: 'Opposite Corners (Diagonal)',
    subs: 2,
    description: 'Cancels all odd-sum modes (n+m+l odd)',
    getPositions: (room) => [
      { x: 0.5, y: 0.5, z: 0 },
      { x: room.length - 0.5, y: room.width - 0.5, z: 0 },
    ],
  },
  'dual-front-rear-midwall': {
    name: 'Front & Rear Midwall',
    subs: 2,
    description: 'At nulls for odd length AND width modes',
    getPositions: (room) => [
      { x: 0.5, y: room.width / 2, z: 0 },
      { x: room.length - 0.5, y: room.width / 2, z: 0 },
    ],
  },
  'dual-side-midwalls': {
    name: 'Left & Right Midwall',
    subs: 2,
    description: 'At nulls for odd length modes',
    getPositions: (room) => [
      { x: room.length / 2, y: 0.5, z: 0 },
      { x: room.length / 2, y: room.width - 0.5, z: 0 },
    ],
  },

  // Triple sub configurations
  'triple-front-wall': {
    name: 'Front Wall Distributed',
    subs: 3,
    description: 'Three across front wall at 1/4, 1/2, 3/4 positions',
    getPositions: (room) => [
      { x: 0.5, y: room.width * 0.25, z: 0 },
      { x: 0.5, y: room.width * 0.5, z: 0 },
      { x: 0.5, y: room.width * 0.75, z: 0 },
    ],
  },
  'triple-lfe-array': {
    name: 'LFE Array (Front + Rear Center)',
    subs: 3,
    description: 'Two front corners + rear center for length mode control',
    getPositions: (room) => [
      { x: 0.5, y: 0.5, z: 0 },
      { x: 0.5, y: room.width - 0.5, z: 0 },
      { x: room.length - 0.5, y: room.width / 2, z: 0 },
    ],
  },

  // Quad sub configurations
  'quad-corners': {
    name: 'Four Corners',
    subs: 4,
    description: 'Cancels all odd-index modes, best seat consistency',
    getPositions: (room) => [
      { x: 0.5, y: 0.5, z: 0 },
      { x: 0.5, y: room.width - 0.5, z: 0 },
      { x: room.length - 0.5, y: 0.5, z: 0 },
      { x: room.length - 0.5, y: room.width - 0.5, z: 0 },
    ],
  },
  'quad-midwalls': {
    name: 'Four Midwalls',
    subs: 4,
    description: 'Midpoint of each wall, nulls many axial modes',
    getPositions: (room) => [
      { x: 0.5, y: room.width / 2, z: 0 },
      { x: room.length - 0.5, y: room.width / 2, z: 0 },
      { x: room.length / 2, y: 0.5, z: 0 },
      { x: room.length / 2, y: room.width - 0.5, z: 0 },
    ],
  },
  'quad-double-bass-array': {
    name: 'Double Bass Array (Front)',
    subs: 4,
    description: 'Four subs across front wall for plane wave',
    getPositions: (room) => [
      { x: 0.5, y: room.width * 0.125, z: 0 },
      { x: 0.5, y: room.width * 0.375, z: 0 },
      { x: 0.5, y: room.width * 0.625, z: 0 },
      { x: 0.5, y: room.width * 0.875, z: 0 },
    ],
  },

  // Five sub configurations
  'five-corners-plus-center': {
    name: 'Four Corners + Front Center',
    subs: 5,
    description: 'Corners for cancellation + center for output',
    getPositions: (room) => [
      { x: 0.5, y: 0.5, z: 0 },
      { x: 0.5, y: room.width - 0.5, z: 0 },
      { x: room.length - 0.5, y: 0.5, z: 0 },
      { x: room.length - 0.5, y: room.width - 0.5, z: 0 },
      { x: 0.5, y: room.width / 2, z: 0 },
    ],
  },

  // Six sub configurations
  'six-distributed': {
    name: 'Six Distributed',
    subs: 6,
    description: 'Three front + three rear for even coverage',
    getPositions: (room) => [
      { x: 0.5, y: room.width * 0.17, z: 0 },
      { x: 0.5, y: room.width * 0.5, z: 0 },
      { x: 0.5, y: room.width * 0.83, z: 0 },
      { x: room.length - 0.5, y: room.width * 0.17, z: 0 },
      { x: room.length - 0.5, y: room.width * 0.5, z: 0 },
      { x: room.length - 0.5, y: room.width * 0.83, z: 0 },
    ],
  },
  'six-corners-plus-midwalls': {
    name: 'Four Corners + Side Midwalls',
    subs: 6,
    description: 'Corners plus left/right midwall for length mode control',
    getPositions: (room) => [
      { x: 0.5, y: 0.5, z: 0 },
      { x: 0.5, y: room.width - 0.5, z: 0 },
      { x: room.length - 0.5, y: 0.5, z: 0 },
      { x: room.length - 0.5, y: room.width - 0.5, z: 0 },
      { x: room.length / 2, y: 0.5, z: 0 },
      { x: room.length / 2, y: room.width - 0.5, z: 0 },
    ],
  },

  // Eight sub configurations
  'eight-perimeter': {
    name: 'Eight Perimeter',
    subs: 8,
    description: 'Two per wall for maximum mode cancellation',
    getPositions: (room) => [
      { x: 0.5, y: room.width * 0.25, z: 0 },
      { x: 0.5, y: room.width * 0.75, z: 0 },
      { x: room.length - 0.5, y: room.width * 0.25, z: 0 },
      { x: room.length - 0.5, y: room.width * 0.75, z: 0 },
      { x: room.length * 0.25, y: 0.5, z: 0 },
      { x: room.length * 0.75, y: 0.5, z: 0 },
      { x: room.length * 0.25, y: room.width - 0.5, z: 0 },
      { x: room.length * 0.75, y: room.width - 0.5, z: 0 },
    ],
  },
  'eight-corners-plus-midwalls': {
    name: 'Four Corners + Four Midwalls',
    subs: 8,
    description: 'Maximum cancellation configuration',
    getPositions: (room) => [
      { x: 0.5, y: 0.5, z: 0 },
      { x: 0.5, y: room.width - 0.5, z: 0 },
      { x: room.length - 0.5, y: 0.5, z: 0 },
      { x: room.length - 0.5, y: room.width - 0.5, z: 0 },
      { x: 0.5, y: room.width / 2, z: 0 },
      { x: room.length - 0.5, y: room.width / 2, z: 0 },
      { x: room.length / 2, y: 0.5, z: 0 },
      { x: room.length / 2, y: room.width - 0.5, z: 0 },
    ],
  },
};

// Grid search for optimal positions
const optimizeSubPositions = (numSubs, modes, room, listener, options = {}) => {
  const {
    gridResolution = 1.5, // feet
    symmetryConstraint = true,
  } = options;

  // Generate grid positions (along walls only for practical placement)
  const positions = [];

  // Front wall positions
  for (let y = 0.5; y < room.width; y += gridResolution) {
    positions.push({ x: 0.5, y, z: 0, wall: 'front' });
  }
  // Rear wall positions
  for (let y = 0.5; y < room.width; y += gridResolution) {
    positions.push({ x: room.length - 0.5, y, z: 0, wall: 'rear' });
  }
  // Left wall positions
  for (let x = gridResolution; x < room.length - gridResolution; x += gridResolution) {
    positions.push({ x, y: 0.5, z: 0, wall: 'left' });
  }
  // Right wall positions
  for (let x = gridResolution; x < room.length - gridResolution; x += gridResolution) {
    positions.push({ x, y: room.width - 0.5, z: 0, wall: 'right' });
  }

  let bestScore = -Infinity;
  let bestConfig = null;

  if (numSubs === 1) {
    // Test all positions
    for (const pos of positions) {
      const score = scoreSubConfig([pos], modes, room, listener);
      if (score.overall > bestScore) {
        bestScore = score.overall;
        bestConfig = { positions: [pos], score };
      }
    }
  } else if (numSubs === 2) {
    // Test pairs (with optional symmetry)
    const frontHalf = positions.filter(p => p.x < room.length / 2 || p.wall === 'front');

    for (let i = 0; i < frontHalf.length; i++) {
      const pos1 = frontHalf[i];

      // If symmetry, only test symmetric counterpart
      if (symmetryConstraint) {
        const pos2 = {
          x: pos1.wall === 'front' ? pos1.x : room.length - pos1.x,
          y: room.width - pos1.y,
          z: 0,
        };
        const score = scoreSubConfig([pos1, pos2], modes, room, listener);
        if (score.overall > bestScore) {
          bestScore = score.overall;
          bestConfig = { positions: [pos1, pos2], score };
        }
      } else {
        // Test all combinations
        for (let j = i + 1; j < positions.length; j++) {
          const pos2 = positions[j];
          const score = scoreSubConfig([pos1, pos2], modes, room, listener);
          if (score.overall > bestScore) {
            bestScore = score.overall;
            bestConfig = { positions: [pos1, pos2], score };
          }
        }
      }
    }
  } else if (numSubs === 4) {
    // For 4 subs, test predefined configurations + symmetric variations
    const quadStrategies = Object.entries(PLACEMENT_STRATEGIES)
      .filter(([, s]) => s.subs === 4);

    for (const [, strategy] of quadStrategies) {
      const subPositions = strategy.getPositions(room);
      const score = scoreSubConfig(subPositions, modes, room, listener);
      if (score.overall > bestScore) {
        bestScore = score.overall;
        bestConfig = { positions: subPositions, score };
      }
    }
  }

  return bestConfig;
};

// ============== UI COMPONENTS ==============

const NumberInput = ({ label, value, onChange, min, max, step = 0.1, unit = '' }) => (
  <div className="flex flex-col gap-1">
    <label className="text-sm text-gray-400">{label}</label>
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        min={min}
        max={max}
        step={step}
        className="w-24 px-2 py-1 bg-gray-700 rounded text-white"
      />
      {unit && <span className="text-gray-400 text-sm">{unit}</span>}
    </div>
  </div>
);

const SpeakerInput = ({ speaker, index, onChange, onRemove }) => (
  <div className="bg-gray-700 rounded p-4 space-y-3">
    <div className="flex justify-between items-center">
      <input
        value={speaker.name}
        onChange={e => onChange(index, { ...speaker, name: e.target.value })}
        className="bg-gray-600 px-2 py-1 rounded text-white font-medium"
        placeholder="Speaker name"
      />
      <button onClick={() => onRemove(index)} className="text-red-400 hover:text-red-300 text-sm">
        Remove
      </button>
    </div>
    <div className="grid grid-cols-4 gap-3">
      <NumberInput
        label="From front"
        value={speaker.x}
        onChange={v => onChange(index, { ...speaker, x: v })}
        unit="ft"
      />
      <NumberInput
        label="From left"
        value={speaker.y}
        onChange={v => onChange(index, { ...speaker, y: v })}
        unit="ft"
      />
      <NumberInput
        label="Woofer Height"
        value={speaker.z}
        onChange={v => onChange(index, { ...speaker, z: v })}
        unit="ft"
      />
      <NumberInput
        label="Power offset"
        value={speaker.powerOffset}
        onChange={v => onChange(index, { ...speaker, powerOffset: v })}
        unit="dB"
        step={1}
      />
    </div>
    <div className="flex gap-4 items-center">
      <div className="flex gap-2 items-center">
        <label className="text-sm text-gray-400">Type:</label>
        <select
          value={speaker.type}
          onChange={e => onChange(index, { ...speaker, type: e.target.value })}
          className="bg-gray-600 px-2 py-1 rounded text-white"
        >
          <option value="Small Sealed">Small Sealed</option>
          <option value="Small Ported">Small Ported</option>
          <option value="Large Sealed">Large Sealed</option>
          <option value="Large Ported">Large Ported</option>
          <option value="Large Dipole">Large Dipole</option>
          <option value="Subwoofer Sealed">Subwoofer Sealed</option>
          <option value="Subwoofer Ported">Subwoofer Ported</option>
        </select>
      </div>
      {speaker.type === 'Large Dipole' && (
        <NumberInput
          label="Orientation (0=facing rear)"
          value={speaker.orientation || 0}
          onChange={v => onChange(index, { ...speaker, orientation: v })}
          unit="°"
          step={15}
          min={0}
          max={360}
        />
      )}
    </div>
  </div>
);

const ModeBar = ({ pressure, showLabel = true }) => {
  let color = 'bg-green-500';
  let label = '';
  if (pressure < 0.15) { color = 'bg-red-500'; label = 'NULL'; }
  else if (pressure < 0.35) { color = 'bg-orange-500'; label = 'Reduced'; }
  else if (pressure > 0.85) { color = 'bg-purple-500'; label = 'PEAK'; }
  else if (pressure > 0.65) { color = 'bg-blue-500'; label = 'Good'; }
  else { color = 'bg-yellow-500'; label = 'Moderate'; }
  
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-4 bg-gray-600 rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pressure * 100}%` }} />
      </div>
      <span className="text-sm w-16">{(pressure * 100).toFixed(0)}%</span>
      {showLabel && <span className="text-xs text-gray-400">{label}</span>}
    </div>
  );
};

const ScoreBar = ({ score }) => {
  let color = 'bg-gray-500';
  if (score >= 70) color = 'bg-green-500';
  else if (score >= 50) color = 'bg-yellow-500';
  else if (score >= 30) color = 'bg-orange-500';
  else color = 'bg-red-500';

  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-4 bg-gray-600 rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-sm font-medium">{score.toFixed(0)}</span>
    </div>
  );
};

const FRCurvePreview = ({ fr, width = 120, height = 40 }) => {
  if (!fr || fr.length === 0) return null;

  const dBValues = fr.map(r => r.dB);
  const minDB = Math.min(...dBValues);
  const maxDB = Math.max(...dBValues);
  const range = maxDB - minDB || 1;

  const points = fr.map((point, i) => {
    const x = (i / (fr.length - 1)) * width;
    const y = height - ((point.dB - minDB) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={width} height={height} className="bg-gray-700 rounded">
      <polyline
        points={points}
        fill="none"
        stroke="#60a5fa"
        strokeWidth="1.5"
      />
    </svg>
  );
};

// ============== MAIN APP ==============

export default function RoomAcousticsApp() {
  // Room state
  const [room, setRoom] = useState({
    length: 18,
    width: 14,
    height: 9,
  });
  
  // Wall openings state
  const [wallOpenings, setWallOpenings] = useState({
    front: 0,
    rear: 0,
    left: 0,
    right: 0,
  });
  
  // Listening position state
  const [listener, setListener] = useState({
    x: 11,
    y: 7,
    z: 3.5,
  });
  
  // Speakers state
  const [speakers, setSpeakers] = useState([
    { name: 'Front Left', x: 2, y: 2, z: 3, type: 'Small Ported', orientation: 0, powerOffset: 0 },
    { name: 'Front Right', x: 2, y: 12, z: 3, type: 'Small Ported', orientation: 0, powerOffset: 0 },
    { name: 'Sub 1', x: 1, y: 1, z: 0, type: 'Subwoofer Sealed', orientation: 0, powerOffset: 0 },
    { name: 'Sub 2', x: 1, y: 13, z: 0, type: 'Subwoofer Sealed', orientation: 0, powerOffset: 0 },
  ]);
  
  // EQ availability
  const [eqAvailable, setEqAvailable] = useState({
    main: false,
    sub: true,
  });

  // Crossover frequency
  const [crossoverFreq, setCrossoverFreq] = useState(null);

  // Subwoofer optimizer state
  const [showSubOptimizer, setShowSubOptimizer] = useState(false);
  const [subOptimizerConfig, setSubOptimizerConfig] = useState({
    numSubs: 2,
    symmetryConstraint: true,
  });
  const [expandedStrategies, setExpandedStrategies] = useState(new Set());

  const updateSpeaker = (index, newSpeaker) => {
    const newSpeakers = [...speakers];
    newSpeakers[index] = newSpeaker;
    setSpeakers(newSpeakers);
  };
  
  const removeSpeaker = (index) => {
    setSpeakers(speakers.filter((_, i) => i !== index));
  };
  
  const addSpeaker = () => {
    setSpeakers([...speakers, {
      name: `Speaker ${speakers.length + 1}`,
      x: room.length / 2,
      y: room.width / 2,
      z: 0,
      type: 'Small Sealed',
      orientation: 0,
      powerOffset: 0,
    }]);
  };
  
  // Calculations
  const volume = room.length * room.width * room.height;
  const schroederFreq = calcSchroederFreq(volume);
  const fundamentalLength = calcModeFreq(1, 0, 0, room.length, room.width, room.height);
  const fundamentalWidth = calcModeFreq(0, 1, 0, room.length, room.width, room.height);
  const fundamentalHeight = calcModeFreq(0, 0, 1, room.length, room.width, room.height);
  
  const modes = useMemo(() => 
    generateModes(room.length, room.width, room.height, 200),
    [room.length, room.width, room.height]
  );
  
  const modesUpToSchroeder = modes.filter(m => m.freq <= schroederFreq);
  
  const modalAnalysis = useMemo(() => {
    return modes.filter(m => m.freq <= 150).map(mode => {
      const lpPressure = calcPressureAtPosition(
        listener.x, listener.y, listener.z, mode, room, wallOpenings
      );
      
      const speakerExcitation = speakers.map(speaker => {
        let excitation;
        if (speaker.type === 'Large Dipole') {
          excitation = calcDipoleExcitation(speaker, mode, room);
        } else {
          excitation = calcPressureAtPosition(speaker.x, speaker.y, speaker.z, mode, room, wallOpenings);
        }
        // Apply power offset
        const powerFactor = Math.pow(10, speaker.powerOffset / 20);
        return { name: speaker.name, excitation, weighted: excitation * powerFactor };
      });
      
      return { ...mode, lpPressure, speakerExcitation };
    });
  }, [modes, listener, speakers, room, wallOpenings]);
  
  const speakerAnalysis = useMemo(() => {
    return speakers.map(speaker => ({
      ...speaker,
      sbir: calcSBIR(speaker, room),
      boundaryGain: calcBoundaryGain(speaker, room, wallOpenings),
    }));
  }, [speakers, room, wallOpenings]);
  
  // Key findings
  const keyFindings = useMemo(() => {
    const nulls = modalAnalysis.filter(m => m.lpPressure < 0.15);
    const peaks = modalAnalysis.filter(m => m.lpPressure > 0.85);
    const problematicBands = [];
    
    // Analyze frequency bands
    const bands = [
      { name: 'Sub-bass', low: 20, high: 40 },
      { name: 'Deep bass', low: 40, high: 60 },
      { name: 'Mid-bass', low: 60, high: 80 },
      { name: 'Upper bass', low: 80, high: 120 },
    ];
    
    bands.forEach(band => {
      const bandModes = modalAnalysis.filter(m => m.freq >= band.low && m.freq < band.high);
      if (bandModes.length > 0) {
        const avgPressure = bandModes.reduce((sum, m) => sum + m.lpPressure, 0) / bandModes.length;
        if (avgPressure < 0.3) {
          problematicBands.push({ ...band, avgPressure, issue: 'reduced' });
        } else if (avgPressure > 0.7) {
          problematicBands.push({ ...band, avgPressure, issue: 'elevated' });
        }
      }
    });
    
    return { nulls, peaks, problematicBands };
  }, [modalAnalysis]);

  // Subwoofer optimizer results
  const subOptimizerResults = useMemo(() => {
    if (!showSubOptimizer) return null;

    const modesForOptimization = modes.filter(m => m.freq <= 120);

    // Evaluate ALL predefined strategies (not filtered by numSubs)
    const allStrategyResults = Object.entries(PLACEMENT_STRATEGIES)
      .map(([key, strategy]) => {
        const positions = strategy.getPositions(room);
        const score = scoreSubConfig(positions, modesForOptimization, room, listener);
        return { key, strategy, positions, score };
      })
      .sort((a, b) => b.score.overall - a.score.overall);

    // Top 10 strategies
    const strategyResults = allStrategyResults.slice(0, 10);

    // Run grid search optimization for selected numSubs
    const optimizedConfig = optimizeSubPositions(
      subOptimizerConfig.numSubs,
      modesForOptimization,
      room,
      listener,
      { symmetryConstraint: subOptimizerConfig.symmetryConstraint }
    );

    return {
      strategyResults,
      allStrategyResults,
      optimizedConfig,
      bestStrategy: strategyResults[0],
    };
  }, [showSubOptimizer, subOptimizerConfig, room, listener, modes]);

  // Generate LLM prompt
  const generateLLMPrompt = () => {
    const prompt = `# Room Acoustics Analysis - Data for LLM Analysis

## Instructions
Analyze this room acoustics data and provide recommendations for:
1. Optimal listening position adjustments
2. Subwoofer placement optimization
3. Speaker placement refinements
4. Predicted frequency response issues and solutions
5. Treatment recommendations

## Important Context for Analysis

**Real-world constraints:** Small-room acoustics are inherently imperfect. Home listening rooms are typically multi-purpose spaces where acoustic optimization must be balanced against aesthetics, furniture placement, traffic flow, and other practical considerations. Recommendations should be pragmatic and prioritized — distinguish between "ideal" and "good enough" solutions, and flag which changes offer the most improvement for the least disruption.

**Complex interactions:** Room acoustics involve complex, non-linear interactions between room modes, speaker radiation patterns, boundary effects, and listener position. A change that improves one frequency may worsen another. Factor these interactions into your recommendations — avoid tunnel vision on single problems, and consider how proposed changes affect the overall system behavior. Where trade-offs exist, make them explicit.

## Room Dimensions
- Length: ${room.length.toFixed(2)} ft (front to back)
- Width: ${room.width.toFixed(2)} ft (left to right)  
- Height: ${room.height.toFixed(2)} ft
- Volume: ${volume.toFixed(0)} ft³
- Schroeder Frequency: ${schroederFreq.toFixed(0)} Hz

## Wall Openings (% open)
- Front: ${wallOpenings.front}%
- Rear: ${wallOpenings.rear}%
- Left: ${wallOpenings.left}%
- Right: ${wallOpenings.right}%

## Fundamental Modes
- Length (1,0,0): ${fundamentalLength.toFixed(1)} Hz
- Width (0,1,0): ${fundamentalWidth.toFixed(1)} Hz
- Height (0,0,1): ${fundamentalHeight.toFixed(1)} Hz

## Room Ratios (normalized to height)
- H:W:L = 1 : ${(room.width/room.height).toFixed(2)} : ${(room.length/room.height).toFixed(2)}

## Listening Position
- From front wall: ${listener.x.toFixed(1)} ft (${(listener.x/room.length*100).toFixed(0)}% of length)
- From left wall: ${listener.y.toFixed(1)} ft (${(listener.y/room.width*100).toFixed(0)}% of width)
- Ear height: ${listener.z.toFixed(1)} ft (${(listener.z/room.height*100).toFixed(0)}% of height)

## Speakers/Subwoofers
${speakers.map(s => `### ${s.name}
- Position: (${s.x.toFixed(1)}', ${s.y.toFixed(1)}', ${s.z.toFixed(1)}')
- Type: ${s.type}
- Power offset: ${s.powerOffset} dB
- Boundary gain: +${speakerAnalysis.find(sa => sa.name === s.name)?.boundaryGain.toFixed(1) || 0} dB
${s.type === 'Large Dipole' ? `- Orientation: ${s.orientation}°` : ''}`).join('\n\n')}

## EQ / Room Correction Availability
- Main speakers: ${eqAvailable.main ? 'YES - DSP/room correction available' : 'NO - positioning and acoustic treatment only'}
- Subwoofers: ${eqAvailable.sub ? 'YES - DSP/room correction available' : 'NO - positioning and acoustic treatment only'}
${!eqAvailable.main && !eqAvailable.sub ? '\n**Note:** With no EQ available, recommendations should focus entirely on positioning, speaker selection, and acoustic treatment.' : ''}
${eqAvailable.sub && !eqAvailable.main ? '\n**Note:** Since only subwoofer EQ is available, main speaker issues must be addressed through positioning. Consider crossover frequency carefully — problems in the crossover region may be difficult to address.' : ''}

## Crossover Frequency
- Crossover between small speakers and subwoofers: ${crossoverFreq ? `${crossoverFreq} Hz` : 'Not specified'}
- Note: Large speakers are assumed to be full-range (no high-pass filter applied)

## Modal Analysis at Listening Position (modes up to 150 Hz)

### Critical Nulls (< 15% pressure at listening position)
${keyFindings.nulls.length > 0 
  ? keyFindings.nulls.map(m => `- ${m.freq.toFixed(1)} Hz (${m.n},${m.m},${m.l}): ${(m.lpPressure*100).toFixed(0)}% pressure`).join('\n')
  : 'None identified'}

### Critical Peaks (> 85% pressure at listening position)
${keyFindings.peaks.length > 0
  ? keyFindings.peaks.map(m => `- ${m.freq.toFixed(1)} Hz (${m.n},${m.m},${m.l}): ${(m.lpPressure*100).toFixed(0)}% pressure`).join('\n')
  : 'None identified'}

### Problematic Frequency Bands
${keyFindings.problematicBands.length > 0
  ? keyFindings.problematicBands.map(b => `- ${b.name} (${b.low}-${b.high} Hz): ${b.issue}, avg ${(b.avgPressure*100).toFixed(0)}% pressure`).join('\n')
  : 'None identified'}

## Full Modal Data (first 30 modes)
| Mode | Freq | Type | Listening Position | ${speakers.map(s => s.name.substring(0,10)).join(' | ')} |
|------|------|------|-------------|${speakers.map(() => '------').join('|')}|
${modalAnalysis.slice(0, 30).map(m => 
  `| (${m.n},${m.m},${m.l}) | ${m.freq.toFixed(1)} | ${m.type.substring(0,4)} | ${(m.lpPressure*100).toFixed(0)}% | ${m.speakerExcitation.map(se => `${(se.excitation*100).toFixed(0)}%`).join(' | ')} |`
).join('\n')}

## SBIR Analysis by Speaker
${speakerAnalysis.map(s => `### ${s.name}
${s.sbir.slice(0, 5).map(sb => `- ${sb.boundary}: ${sb.distance.toFixed(1)} ft → ${sb.freq.toFixed(0)} Hz null`).join('\n')}`).join('\n\n')}

## Analysis Request
Based on this data, please provide:
1. Assessment of the most significant acoustic problems
2. Recommended listening position adjustments (if any)
3. Recommended speaker/sub placement changes (if any)
4. Expected frequency response characteristics
5. Priority-ranked list of improvements
`;
    return prompt;
  };
  
  const [showPrompt, setShowPrompt] = useState(false);
  
  // Serialization for save/restore
  const [importText, setImportText] = useState('');
  const [showImportExport, setShowImportExport] = useState(false);
  
  const serializeState = () => {
    return JSON.stringify({
      version: 1,
      room,
      wallOpenings,
      listener,
      speakers,
      eqAvailable,
      crossoverFreq,
    }, null, 2);
  };
  
  const serializeCompact = () => {
    return JSON.stringify({
      v: 1,
      r: [room.length, room.width, room.height],
      w: [wallOpenings.front, wallOpenings.rear, wallOpenings.left, wallOpenings.right],
      l: [listener.x, listener.y, listener.z],
      s: speakers.map(s => [s.name, s.x, s.y, s.z, s.type, s.orientation || 0, s.powerOffset || 0]),
      e: [eqAvailable.main ? 1 : 0, eqAvailable.sub ? 1 : 0],
      c: crossoverFreq,
    });
  };
  
  const deserializeCompact = (data) => {
    if (data.r) setRoom({ length: data.r[0], width: data.r[1], height: data.r[2] });
    if (data.w) setWallOpenings({ front: data.w[0], rear: data.w[1], left: data.w[2], right: data.w[3] });
    if (data.l) setListener({ x: data.l[0], y: data.l[1], z: data.l[2] });
    if (data.s) setSpeakers(data.s.map(s => ({
      name: s[0], x: s[1], y: s[2], z: s[3],
      type: s[4],
      orientation: s[5] || 0,
      powerOffset: s[6] || 0,
    })));
    if (data.e) setEqAvailable({ main: data.e[0] === 1, sub: data.e[1] === 1 });
    if (data.c) setCrossoverFreq(data.c);
  };
  
  // URL-safe base64
  const toUrlSafe = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromUrlSafe = (str) => {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
  };
  
  const generatePermalink = () => {
    const compressed = toUrlSafe(serializeCompact());
    const url = new URL(window.location.href.split('?')[0]);
    url.searchParams.set('c', compressed);
    return url.toString();
  };
  
  // Load from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const configParam = params.get('c');
    if (configParam) {
      try {
        const json = fromUrlSafe(configParam);
        const data = JSON.parse(json);
        deserializeCompact(data);
      } catch (e) {
        console.error('Failed to load config from URL:', e);
      }
    }
  }, []);

  // Sync state to URL
  useEffect(() => {
    const compressed = toUrlSafe(serializeCompact());
    const url = new URL(window.location.href.split('?')[0]);
    url.searchParams.set('c', compressed);
    window.history.replaceState(null, '', url.toString());
  }, [room, wallOpenings, listener, speakers, eqAvailable, crossoverFreq]);

  const deserializeState = (jsonStr) => {
    try {
      const data = JSON.parse(jsonStr);
      // Handle compact format
      if (data.v && data.r) {
        deserializeCompact(data);
        setImportText('');
        setShowImportExport(false);
        return true;
      }
      // Handle verbose format
      if (data.room) setRoom(data.room);
      if (data.wallOpenings) setWallOpenings(data.wallOpenings);
      if (data.listener) setListener(data.listener);
      if (data.speakers) setSpeakers(data.speakers);
      if (data.eqAvailable) setEqAvailable(data.eqAvailable);
      if (data.crossoverFreq) setCrossoverFreq(data.crossoverFreq);
      setImportText('');
      setShowImportExport(false);
      return true;
    } catch (e) {
      alert('Invalid configuration data: ' + e.message);
      return false;
    }
  };
  
  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold">Room Acoustics Analyzer</h1>
        
        {/* Import/Export Configuration */}
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-semibold">Configuration</h2>
            <div className="flex gap-2">
              <button
                onClick={() => setShowImportExport(!showImportExport)}
                className="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 text-sm"
              >
                {showImportExport ? 'Hide' : 'Import/Export'}
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(serializeState())}
                className="px-3 py-1 bg-green-700 rounded hover:bg-green-600 text-sm"
              >
                Copy Config
              </button>
              <button
                onClick={() => {
                  const url = generatePermalink();
                  navigator.clipboard.writeText(url);
                  alert('Permalink copied to clipboard!');
                }}
                className="px-3 py-1 bg-purple-700 rounded hover:bg-purple-600 text-sm"
              >
                Copy Permalink
              </button>
            </div>
          </div>
          {showImportExport && (
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-sm text-gray-400 block mb-1">Current Configuration (copy to save)</label>
                <pre className="bg-gray-900 p-3 rounded text-xs overflow-x-auto max-h-40 overflow-y-auto">
                  {serializeState()}
                </pre>
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Paste Configuration to Restore</label>
                <textarea
                  value={importText}
                  onChange={e => setImportText(e.target.value)}
                  placeholder="Paste previously exported configuration here..."
                  className="w-full h-32 bg-gray-900 p-3 rounded text-xs font-mono"
                />
                <button
                  onClick={() => deserializeState(importText)}
                  disabled={!importText.trim()}
                  className="mt-2 px-4 py-2 bg-blue-600 rounded hover:bg-blue-500 disabled:bg-gray-600 disabled:cursor-not-allowed"
                >
                  Load Configuration
                </button>
              </div>
            </div>
          )}
        </div>
        
        {/* INPUT SECTION */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Room Dimensions */}
          <div className="bg-gray-800 rounded-lg p-4 space-y-4">
            <h2 className="text-xl font-semibold">Room Dimensions</h2>
            <div className="grid grid-cols-3 gap-4">
              <NumberInput label="Length" value={room.length} onChange={v => setRoom({...room, length: v})} unit="ft" />
              <NumberInput label="Width" value={room.width} onChange={v => setRoom({...room, width: v})} unit="ft" />
              <NumberInput label="Height" value={room.height} onChange={v => setRoom({...room, height: v})} unit="ft" />
            </div>
            <h3 className="text-lg font-medium mt-4">Wall Openings</h3>
            <p className="text-sm text-gray-400 mb-2">If this wall is open to another room, measure the total area that is open, and divide that by the area of the wall to get a %.</p>
            <div className="grid grid-cols-4 gap-4">
              <NumberInput label="Front" value={wallOpenings.front} onChange={v => setWallOpenings({...wallOpenings, front: v})} unit="%" step={5} />
              <NumberInput label="Rear" value={wallOpenings.rear} onChange={v => setWallOpenings({...wallOpenings, rear: v})} unit="%" step={5} />
              <NumberInput label="Left" value={wallOpenings.left} onChange={v => setWallOpenings({...wallOpenings, left: v})} unit="%" step={5} />
              <NumberInput label="Right" value={wallOpenings.right} onChange={v => setWallOpenings({...wallOpenings, right: v})} unit="%" step={5} />
            </div>
          </div>
          
          {/* Listening Position */}
          <div className="bg-gray-800 rounded-lg p-4 space-y-4">
            <h2 className="text-xl font-semibold">Listening Position</h2>
            <div className="grid grid-cols-3 gap-4">
              <NumberInput label="From front wall" value={listener.x} onChange={v => setListener({...listener, x: v})} unit="ft" />
              <NumberInput label="From left wall" value={listener.y} onChange={v => setListener({...listener, y: v})} unit="ft" />
              <NumberInput label="Ear height" value={listener.z} onChange={v => setListener({...listener, z: v})} unit="ft" />
            </div>
            <div className="text-sm text-gray-400 mt-2">
              Position: {(listener.x/room.length*100).toFixed(0)}% from front, {(listener.y/room.width*100).toFixed(0)}% from left, {(listener.z/room.height*100).toFixed(0)}% height
            </div>
          </div>
        </div>
        
        {/* Speakers */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">Speakers &amp; Subwoofers</h2>
            <button onClick={addSpeaker} className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-500">
              Add Speaker
            </button>
          </div>
          <p className="text-sm text-gray-400">Measure distances based on the centerpoint of the woofer. If a speaker has multiple woofers, measure based on the midpoint of the woofer array.</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {speakers.map((speaker, i) => (
              <SpeakerInput
                key={i}
                speaker={speaker}
                index={i}
                onChange={updateSpeaker}
                onRemove={removeSpeaker}
              />
            ))}
          </div>
          
          {/* Crossover Frequency */}
          <div className="border-t border-gray-700 pt-4 mt-4">
            <h3 className="text-lg font-medium mb-2">Crossover Frequency</h3>
            <p className="text-sm text-gray-400 mb-3">Crossover frequency between small speakers and subwoofers. (Only used in conjunction with small speakers. Large speakers are assumed to be full-range.)</p>
            <div className="flex flex-col gap-1">
              <label className="text-sm text-gray-400">Crossover</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={crossoverFreq ?? ''}
                  onChange={e => setCrossoverFreq(e.target.value === '' ? null : parseFloat(e.target.value) || null)}
                  min={40}
                  max={200}
                  step={5}
                  placeholder="—"
                  className="w-24 px-2 py-1 bg-gray-700 rounded text-white"
                />
                <span className="text-gray-400 text-sm">Hz</span>
              </div>
            </div>
          </div>

          {/* EQ Availability */}
          <div className="border-t border-gray-700 pt-4 mt-4">
            <h3 className="text-lg font-medium mb-3">EQ Availability</h3>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={eqAvailable.main}
                  onChange={e => setEqAvailable({ ...eqAvailable, main: e.target.checked })}
                  className="w-4 h-4 rounded"
                />
                <span>Main speakers (DSP/room correction)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={eqAvailable.sub}
                  onChange={e => setEqAvailable({ ...eqAvailable, sub: e.target.checked })}
                  className="w-4 h-4 rounded"
                />
                <span>Subwoofers (DSP/room correction)</span>
              </label>
            </div>
          </div>
        </div>
        
        {/* OUTPUT SECTION 1: Room Info */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-4">
          <h2 className="text-xl font-semibold">1. Room Information</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-700 rounded p-3">
              <div className="text-sm text-gray-400">Volume</div>
              <div className="text-xl font-bold">{volume.toFixed(0)} ft³</div>
            </div>
            <div className="bg-gray-700 rounded p-3">
              <div className="text-sm text-gray-400">Schroeder Frequency</div>
              <div className="text-xl font-bold">{schroederFreq.toFixed(0)} Hz</div>
            </div>
            <div className="bg-gray-700 rounded p-3">
              <div className="text-sm text-gray-400">Fundamental Length Mode</div>
              <div className="text-xl font-bold">{fundamentalLength.toFixed(1)} Hz</div>
            </div>
            <div className="bg-gray-700 rounded p-3">
              <div className="text-sm text-gray-400">Room Ratio (H:W:L)</div>
              <div className="text-xl font-bold">1 : {(room.width/room.height).toFixed(2)} : {(room.length/room.height).toFixed(2)}</div>
            </div>
          </div>
          
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-700 rounded p-3">
              <div className="text-sm text-gray-400">Length (1,0,0)</div>
              <div className="text-lg font-medium">{fundamentalLength.toFixed(1)} Hz</div>
            </div>
            <div className="bg-gray-700 rounded p-3">
              <div className="text-sm text-gray-400">Width (0,1,0)</div>
              <div className="text-lg font-medium">{fundamentalWidth.toFixed(1)} Hz</div>
            </div>
            <div className="bg-gray-700 rounded p-3">
              <div className="text-sm text-gray-400">Height (0,0,1)</div>
              <div className="text-lg font-medium">{fundamentalHeight.toFixed(1)} Hz</div>
            </div>
          </div>
          
          <div>
            <h3 className="font-medium mb-2">Modes up to Schroeder ({schroederFreq.toFixed(0)} Hz)</h3>
            <div className="flex gap-4 text-sm">
              <span className="text-red-400">Axial: {modesUpToSchroeder.filter(m => m.type === 'axial').length}</span>
              <span className="text-yellow-400">Tangential: {modesUpToSchroeder.filter(m => m.type === 'tangential').length}</span>
              <span className="text-blue-400">Oblique: {modesUpToSchroeder.filter(m => m.type === 'oblique').length}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {modesUpToSchroeder.map((m, i) => (
                <span
                  key={i}
                  className={`px-2 py-1 rounded text-xs ${
                    m.type === 'axial' ? 'bg-red-900 text-red-200' :
                    m.type === 'tangential' ? 'bg-yellow-900 text-yellow-200' :
                    'bg-blue-900 text-blue-200'
                  }`}
                  title={`(${m.n},${m.m},${m.l}) - ${m.type}`}
                >
                  {m.freq.toFixed(0)}
                </span>
              ))}
            </div>
          </div>
        </div>
        
        {/* OUTPUT SECTION 2: Listening Position */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-4">
          <h2 className="text-xl font-semibold">2. Listening Position Analysis</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="p-2">Mode</th>
                  <th className="p-2">Freq</th>
                  <th className="p-2">Type</th>
                  <th className="p-2">Level</th>
                  <th className="p-2">Pressure at listening position</th>
                </tr>
              </thead>
              <tbody>
                {modalAnalysis.filter(m => m.freq <= 120).map((m, i) => (
                  <tr key={i} className={`border-b border-gray-700 ${m.lpPressure < 0.15 ? 'bg-red-900/20' : m.lpPressure > 0.85 ? 'bg-purple-900/20' : ''}`}>
                    <td className="p-2 font-mono">({m.n},{m.m},{m.l})</td>
                    <td className="p-2">{m.freq.toFixed(1)} Hz</td>
                    <td className="p-2">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        m.type === 'axial' ? 'bg-red-900' :
                        m.type === 'tangential' ? 'bg-yellow-900' : 'bg-blue-900'
                      }`}>{m.type}</span>
                    </td>
                    <td className="p-2">{m.level} dB</td>
                    <td className="p-2"><ModeBar pressure={m.lpPressure} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        
        {/* OUTPUT SECTION 3: Speaker Analysis */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-4">
          <h2 className="text-xl font-semibold">3. Speaker Position Analysis</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {speakerAnalysis.map((speaker, i) => {
              const modeExcitations = modalAnalysis
                .filter(m => m.freq <= 120)
                .map(m => ({
                  ...m,
                  excitation: m.speakerExcitation[i]?.excitation || 0
                }))
                .sort((a, b) => b.excitation - a.excitation);
              const strongModes = modeExcitations.filter(m => m.excitation > 0.7);
              const weakModes = modeExcitations.filter(m => m.excitation < 0.2);

              return (
              <div key={i} className="bg-gray-700 rounded p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="font-medium">{speaker.name}</h3>
                  <span className="text-sm text-gray-400">{speaker.type}</span>
                </div>
                <div className="text-sm">
                  <span className="text-gray-400">Boundary gain:</span> +{speaker.boundaryGain.toFixed(1)} dB
                </div>
                <div>
                  <h4 className="text-sm text-gray-400 mb-1">SBIR Cancellation Frequencies</h4>
                  <div className="space-y-1">
                    {speaker.sbir.slice(0, 5).map((sb, j) => (
                      <div key={j} className="flex justify-between text-sm">
                        <span>{sb.boundary}</span>
                        <span>{sb.distance.toFixed(1)} ft → <strong>{sb.freq.toFixed(0)} Hz</strong></span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h4 className="text-sm text-gray-400 mb-1">Mode Excitation</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="bg-green-900/30 rounded p-2">
                      <div className="text-xs text-green-400 mb-1">Strong ({'>'}70%)</div>
                      <div className="space-y-0.5">
                        {strongModes.slice(0, 5).map((m, j) => (
                          <div key={j} className="text-xs flex justify-between">
                            <span className="font-mono">({m.n},{m.m},{m.l})</span>
                            <span>{m.freq.toFixed(0)} Hz <strong>{(m.excitation * 100).toFixed(0)}%</strong></span>
                          </div>
                        ))}
                        {strongModes.length === 0 && <div className="text-xs text-gray-500">None</div>}
                      </div>
                    </div>
                    <div className="bg-gray-800/50 rounded p-2">
                      <div className="text-xs text-gray-400 mb-1">Weak ({'<'}20%)</div>
                      <div className="space-y-0.5">
                        {weakModes.slice(0, 5).map((m, j) => (
                          <div key={j} className="text-xs flex justify-between">
                            <span className="font-mono">({m.n},{m.m},{m.l})</span>
                            <span>{m.freq.toFixed(0)} Hz <strong>{(m.excitation * 100).toFixed(0)}%</strong></span>
                          </div>
                        ))}
                        {weakModes.length === 0 && <div className="text-xs text-gray-500">None</div>}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );})}
          </div>
        </div>
        
        {/* OUTPUT SECTION 4: Combined Picture */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-4">
          <h2 className="text-xl font-semibold">4. Combined Analysis</h2>
          
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-700">
                  <th className="p-2">Mode</th>
                  <th className="p-2">Freq</th>
                  <th className="p-2">Type</th>
                  <th className="p-2">Listening position</th>
                  {speakers.map((s, i) => (
                    <th key={i} className="p-2">{s.name.substring(0, 12)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {modalAnalysis.filter(m => m.freq <= 120).map((m, i) => (
                  <tr key={i} className="border-b border-gray-700">
                    <td className="p-2 font-mono">({m.n},{m.m},{m.l})</td>
                    <td className="p-2">{m.freq.toFixed(1)} Hz</td>
                    <td className="p-2">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        m.type === 'axial' ? 'bg-red-900' :
                        m.type === 'tangential' ? 'bg-yellow-900' : 'bg-blue-900'
                      }`}>{m.type}</span>
                    </td>
                    <td className="p-2">
                      <span className={`px-2 py-0.5 rounded ${
                        m.lpPressure < 0.15 ? 'bg-red-700' :
                        m.lpPressure > 0.85 ? 'bg-purple-700' : 'bg-gray-600'
                      }`}>
                        {(m.lpPressure * 100).toFixed(0)}%
                      </span>
                    </td>
                    {m.speakerExcitation.map((se, j) => (
                      <td key={j} className="p-2">
                        <span className={`px-2 py-0.5 rounded ${
                          se.excitation < 0.2 ? 'bg-gray-600 text-gray-400' :
                          se.excitation > 0.7 ? 'bg-green-700' : 'bg-yellow-700'
                        }`}>
                          {(se.excitation * 100).toFixed(0)}%
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <div className="bg-red-900/30 border border-red-700 rounded p-4">
              <h3 className="font-medium text-red-300 mb-2">⚠️ Nulls at Listening Position</h3>
              {keyFindings.nulls.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {keyFindings.nulls.map((m, i) => (
                    <li key={i}>
                      <strong>{m.freq.toFixed(1)} Hz</strong> ({m.n},{m.m},{m.l}): {(m.lpPressure*100).toFixed(0)}% pressure
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-400">No critical nulls identified</p>
              )}
            </div>
            <div className="bg-purple-900/30 border border-purple-700 rounded p-4">
              <h3 className="font-medium text-purple-300 mb-2">📈 Peaks at Listening Position</h3>
              {keyFindings.peaks.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {keyFindings.peaks.map((m, i) => (
                    <li key={i}>
                      <strong>{m.freq.toFixed(1)} Hz</strong> ({m.n},{m.m},{m.l}): {(m.lpPressure*100).toFixed(0)}% pressure
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-400">No critical peaks identified</p>
              )}
            </div>
          </div>
        </div>
        
        {/* OUTPUT SECTION 5: LLM Prompt */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">5. LLM Analysis Prompt</h2>
            <div className="flex gap-2">
              <button
                onClick={() => setShowPrompt(!showPrompt)}
                className="px-4 py-2 bg-gray-700 rounded hover:bg-gray-600"
              >
                {showPrompt ? 'Hide' : 'Show'} Prompt
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(generateLLMPrompt())}
                className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-500"
              >
                Copy to Clipboard
              </button>
            </div>
          </div>
          {showPrompt && (
            <pre className="bg-gray-900 p-4 rounded overflow-x-auto text-xs whitespace-pre-wrap max-h-96 overflow-y-auto">
              {generateLLMPrompt()}
            </pre>
          )}
        </div>

        {/* OUTPUT SECTION 6: Subwoofer Placement Optimizer */}
        <div className="bg-gray-800 rounded-lg p-4 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">6. Subwoofer Placement Optimizer</h2>
            <button
              onClick={() => setShowSubOptimizer(!showSubOptimizer)}
              className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-500"
            >
              {showSubOptimizer ? 'Hide' : 'Analyze Placements'}
            </button>
          </div>

          {showSubOptimizer && (
            <>
              {/* Configuration Panel */}
              <div className="bg-gray-700 rounded p-4 space-y-4">
                <h3 className="font-medium">Grid Search Configuration</h3>
                <div className="flex flex-wrap gap-6">
                  {/* Number of Subs for grid search */}
                  <div className="flex flex-col gap-2">
                    <label className="text-sm text-gray-400">Subs for Grid Search</label>
                    <div className="flex gap-1">
                      {[1, 2, 3, 4, 5, 6, 8].map(n => (
                        <button
                          key={n}
                          onClick={() => setSubOptimizerConfig({ ...subOptimizerConfig, numSubs: n })}
                          className={`px-3 py-1 rounded text-sm ${
                            subOptimizerConfig.numSubs === n
                              ? 'bg-blue-600'
                              : 'bg-gray-600 hover:bg-gray-500'
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Symmetry Toggle */}
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={subOptimizerConfig.symmetryConstraint}
                      onChange={e => setSubOptimizerConfig({
                        ...subOptimizerConfig,
                        symmetryConstraint: e.target.checked
                      })}
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-sm">Enforce Left/Right Symmetry</span>
                  </label>
                </div>
              </div>

              {/* Results */}
              {subOptimizerResults && (
                <div className="space-y-4">
                  {/* Strategy Comparison Table */}
                  <h3 className="font-medium">Top 10 Strategies (click row to expand)</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-400 border-b border-gray-700">
                          <th className="p-2">Rank</th>
                          <th className="p-2">Subs</th>
                          <th className="p-2">Strategy</th>
                          <th className="p-2">FR Preview</th>
                          <th className="p-2">Peak-to-Peak</th>
                          <th className="p-2">Score</th>
                          <th className="p-2">Positions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subOptimizerResults.strategyResults.map((result, i) => {
                          const isExpanded = expandedStrategies.has(result.key);
                          return (
                          <React.Fragment key={result.key}>
                            <tr
                              onClick={() => {
                                const newExpanded = new Set(expandedStrategies);
                                if (isExpanded) {
                                  newExpanded.delete(result.key);
                                } else {
                                  newExpanded.add(result.key);
                                }
                                setExpandedStrategies(newExpanded);
                              }}
                              className={`border-b border-gray-700 cursor-pointer hover:bg-gray-700/50 ${i === 0 ? 'bg-green-900/20' : ''}`}
                            >
                              <td className="p-2">{i === 0 ? '🏆' : i + 1}</td>
                              <td className="p-2">
                                <span className="px-2 py-0.5 bg-gray-600 rounded text-xs">{result.strategy.subs}</span>
                              </td>
                              <td className="p-2">
                                <div className="font-medium flex items-center gap-1">
                                  <span className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                                  {result.strategy.name}
                                </div>
                                <div className="text-xs text-gray-400 ml-4">{result.strategy.description}</div>
                              </td>
                              <td className="p-2">
                                <FRCurvePreview fr={result.score.fr} />
                              </td>
                              <td className="p-2">±{(result.score.peakToPeak / 2).toFixed(1)} dB</td>
                              <td className="p-2">
                                <ScoreBar score={result.score.overall} />
                              </td>
                              <td className="p-2 font-mono text-xs">
                                {result.positions.map((p, j) => (
                                  <div key={j}>({p.x.toFixed(1)}, {p.y.toFixed(1)})</div>
                                ))}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-gray-900">
                                <td colSpan={7} className="p-4">
                                  <div className="text-sm font-medium mb-2">Mode-by-Mode Impact</div>
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-xs">
                                      <thead>
                                        <tr className="text-left text-gray-400 border-b border-gray-600">
                                          <th className="p-1">Mode</th>
                                          <th className="p-1">Freq</th>
                                          <th className="p-1">Type</th>
                                          <th className="p-1">LP Pressure</th>
                                          <th className="p-1">Net Excitation</th>
                                          <th className="p-1">Impact</th>
                                          <th className="p-1">Status</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {result.score.modeDetails.slice(0, 15).map((detail, k) => (
                                          <tr key={k} className="border-b border-gray-700">
                                            <td className="p-1 font-mono">({detail.mode.n},{detail.mode.m},{detail.mode.l})</td>
                                            <td className="p-1">{detail.mode.freq.toFixed(1)} Hz</td>
                                            <td className="p-1">
                                              <span className={`px-1 rounded text-xs ${
                                                detail.mode.type === 'axial' ? 'bg-red-900' :
                                                detail.mode.type === 'tangential' ? 'bg-yellow-900' : 'bg-blue-900'
                                              }`}>{detail.mode.type.substring(0, 3)}</span>
                                            </td>
                                            <td className="p-1">{(detail.lpPressure * 100).toFixed(0)}%</td>
                                            <td className="p-1">
                                              <span className={detail.isCancelled ? 'text-green-400' : ''}>
                                                {(detail.absExcitation * 100).toFixed(0)}%
                                              </span>
                                            </td>
                                            <td className="p-1">
                                              <div className="w-16 h-2 bg-gray-600 rounded overflow-hidden">
                                                <div
                                                  className={`h-full ${detail.effectiveImpact > 0.5 ? 'bg-purple-500' : detail.effectiveImpact < 0.2 ? 'bg-green-500' : 'bg-yellow-500'}`}
                                                  style={{ width: `${Math.min(100, detail.effectiveImpact * 100)}%` }}
                                                />
                                              </div>
                                            </td>
                                            <td className="p-1">
                                              {detail.isCancelled && <span className="text-green-400">Cancelled</span>}
                                              {detail.lpPressure < 0.15 && <span className="text-red-400">LP Null</span>}
                                              {detail.lpPressure > 0.85 && detail.absExcitation > 0.5 && <span className="text-orange-400">Peak</span>}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                  <div className="mt-2 text-xs text-gray-400">
                                    Showing first 15 modes. Green = cancelled by multi-sub configuration, Purple = strong impact at LP.
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );})}
                      </tbody>
                    </table>
                  </div>

                  {/* Best Results Summary */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Best Strategy */}
                    {subOptimizerResults.bestStrategy && (
                      <div className="bg-green-900/30 border border-green-700 rounded p-4">
                        <h4 className="font-medium text-green-300 mb-2">
                          Best Strategy: {subOptimizerResults.bestStrategy.strategy.name}
                        </h4>
                        <div className="space-y-2 text-sm">
                          <div>
                            <span className="text-gray-400">Score:</span>{' '}
                            <strong>{subOptimizerResults.bestStrategy.score.overall.toFixed(0)}/100</strong>
                          </div>
                          <div>
                            <span className="text-gray-400">Peak-to-Peak:</span>{' '}
                            ±{(subOptimizerResults.bestStrategy.score.peakToPeak / 2).toFixed(1)} dB
                          </div>
                          <div>
                            <span className="text-gray-400">Positions:</span>
                            <ul className="mt-1 font-mono">
                              {subOptimizerResults.bestStrategy.positions.map((pos, i) => (
                                <li key={i}>
                                  Sub {i + 1}: {pos.x.toFixed(1)}' from front, {pos.y.toFixed(1)}' from left
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Optimized Placement */}
                    {subOptimizerResults.optimizedConfig && (
                      <div className="bg-blue-900/30 border border-blue-700 rounded p-4">
                        <h4 className="font-medium text-blue-300 mb-2">
                          Grid Search Optimized
                        </h4>
                        <div className="space-y-2 text-sm">
                          <div>
                            <span className="text-gray-400">Score:</span>{' '}
                            <strong>{subOptimizerResults.optimizedConfig.score.overall.toFixed(0)}/100</strong>
                          </div>
                          <div>
                            <span className="text-gray-400">Peak-to-Peak:</span>{' '}
                            ±{(subOptimizerResults.optimizedConfig.score.peakToPeak / 2).toFixed(1)} dB
                          </div>
                          <div>
                            <span className="text-gray-400">Positions:</span>
                            <ul className="mt-1 font-mono">
                              {subOptimizerResults.optimizedConfig.positions.map((pos, i) => (
                                <li key={i}>
                                  Sub {i + 1}: {pos.x.toFixed(1)}' from front, {pos.y.toFixed(1)}' from left
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div className="mt-2">
                            <FRCurvePreview fr={subOptimizerResults.optimizedConfig.score.fr} width={200} height={60} />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Explanation */}
                  <div className="bg-gray-700 rounded p-4">
                    <h4 className="font-medium mb-2">How This Works</h4>
                    <p className="text-sm text-gray-300">
                      The optimizer predicts the frequency response at your listening position for each subwoofer configuration.
                      It scores configurations based on <strong>flatness</strong> — lower peak-to-peak variation means more even bass response.
                    </p>
                    <ul className="mt-2 text-sm text-gray-400 list-disc list-inside space-y-1">
                      <li>Multi-sub setups can <strong>cancel</strong> problematic room modes via phase opposition</li>
                      <li>Opposite corners cancel modes where n+m+l is odd (e.g., the fundamental modes)</li>
                      <li>Midwall placements sit at nulls for odd modes in that dimension</li>
                      <li>Positions are scored by the predicted frequency response at your listening position</li>
                    </ul>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Room Visualization */}
        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-xl font-semibold mb-4">Room Layout (Top View)</h2>
          <div 
            className="relative bg-gray-900 rounded mx-auto"
            style={{ 
              width: '100%',
              maxWidth: '500px',
              aspectRatio: `${room.width} / ${room.length}`
            }}
          >
            {/* Wall labels */}
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-sm text-gray-400">
              FRONT {wallOpenings.front > 0 && `(${wallOpenings.front}% open)`}
            </div>
            <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-sm text-gray-400">
              REAR {wallOpenings.rear > 0 && `(${wallOpenings.rear}% open)`}
            </div>
            <div className="absolute -left-8 top-1/2 -translate-y-1/2 -rotate-90 text-sm text-gray-400">
              LEFT {wallOpenings.left > 0 && `(${wallOpenings.left}% open)`}
            </div>
            <div className="absolute -right-8 top-1/2 -translate-y-1/2 rotate-90 text-sm text-gray-400">
              RIGHT {wallOpenings.right > 0 && `(${wallOpenings.right}% open)`}
            </div>
            
            {/* Open wall indicators - centered on each wall */}
            {wallOpenings.front > 0 && (
              <div 
                className="absolute top-0 h-2 bg-yellow-600/50" 
                style={{ 
                  width: `${wallOpenings.front}%`, 
                  left: `${(100 - wallOpenings.front) / 2}%` 
                }} 
              />
            )}
            {wallOpenings.rear > 0 && (
              <div 
                className="absolute bottom-0 h-2 bg-yellow-600/50" 
                style={{ 
                  width: `${wallOpenings.rear}%`, 
                  left: `${(100 - wallOpenings.rear) / 2}%` 
                }} 
              />
            )}
            {wallOpenings.left > 0 && (
              <div 
                className="absolute left-0 w-2 bg-yellow-600/50" 
                style={{ 
                  height: `${wallOpenings.left}%`, 
                  top: `${(100 - wallOpenings.left) / 2}%` 
                }} 
              />
            )}
            {wallOpenings.right > 0 && (
              <div 
                className="absolute right-0 w-2 bg-yellow-600/50" 
                style={{ 
                  height: `${wallOpenings.right}%`, 
                  top: `${(100 - wallOpenings.right) / 2}%` 
                }} 
              />
            )}
            
            {/* Speakers */}
            {speakers.map((speaker, i) => (
              <div
                key={i}
                className={`absolute w-6 h-6 rounded-full border-2 flex items-center justify-center text-xs font-bold transform -translate-x-1/2 -translate-y-1/2 ${
                  speaker.type === 'Large Dipole' ? 'bg-purple-600 border-purple-300' : 'bg-green-600 border-green-300'
                }`}
                style={{
                  left: `${(speaker.y / room.width) * 100}%`,
                  top: `${(speaker.x / room.length) * 100}%`,
                }}
                title={speaker.name}
              >
                {i + 1}
              </div>
            ))}
            
            {/* Listener */}
            <div
              className="absolute w-8 h-8 bg-blue-500 rounded-full border-2 border-white flex items-center justify-center transform -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${(listener.y / room.width) * 100}%`,
                top: `${(listener.x / room.length) * 100}%`,
              }}
            >
              👤
            </div>
            
            {/* Legend */}
            <div className="absolute bottom-2 right-2 text-xs space-y-1 bg-gray-800/80 p-2 rounded">
              {speakers.map((speaker, i) => (
                <div key={i} className="flex items-center gap-1">
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                    speaker.type === 'Large Dipole' ? 'bg-purple-600' : 'bg-green-600'
                  }`}>{i + 1}</div>
                  <span>{speaker.name}</span>
                </div>
              ))}
              <div className="flex items-center gap-1">
                <div className="w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center">👤</div>
                <span>Listener</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
