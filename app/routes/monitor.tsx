import type { Route } from "./+types/monitor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Monitor - Puddle" },
  ];
}

interface SeriesConfig {
  label: string;
}

interface ChartConfig {
  title: string;
  query: string;
  series: SeriesConfig[];
  yDomain?: [number | null, number | null];
  initialYDomain?: [number, number];
  yCenterZero?: boolean;
  yLabel?: string;
  className?: string;
}

interface QuestDbResponse {
  query: string;
  columns: { name: string; type: string }[];
  dataset: [string, ...(number | null)[]][];
  count: number;
}

interface SelectedRange {
  start: Date;
  end: Date;
}

interface TimelineBin {
  start: Date;
  end: Date;
  dataStart: Date | null;
  dataEnd: Date | null;
  isAvailable: boolean;
  intensity: number;
}

const DEFAULT_CHART_WIDTH_PX = 400;
const CHART_PLOT_HORIZONTAL_MARGIN_PX = 65;
const MIN_AVAILABLE_INTENSITY = 0.18;
const TIMELINE_ROW_SIZE = 6;
const LIVE_DURATION_OPTIONS = [
  { label: "5 min", ms: 5 * 60 * 1000 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
] as const;

const CHART_COLORS = [
  "#9B111E", // Ruby Red (Primary Brand)
  "#2E4053", // Industrial Slate
  "#117864", // Industrial Emerald
  "#D68910", // Industrial Amber/Brass
  "#5D6D7E", // Cool Steel Gray
  "#7B241C", // Dark Iron Rust
  "#1B4F72", // Deep Ocean/Machinery Blue
  "#145A32", // Dark Moss Green
];

const DEFAULT_CHARTS: ChartConfig[] = [
  {
    title: "System Temperatures",
    query: `
      SELECT l.timestamp,
        avg(r.cpu_thermal_temp / 1000.0), min(r.cpu_thermal_temp / 1000.0), max(r.cpu_thermal_temp / 1000.0),
        avg(l.drive_temperature / 10.0), min(l.drive_temperature / 10.0), max(l.drive_temperature / 10.0),
        avg(round((l.motor_temperature * (50.0 / 51.0)) - 50.0, 2)), min(round((l.motor_temperature * (50.0 / 51.0)) - 50.0, 2)), max(round((l.motor_temperature * (50.0 / 51.0)) - 50.0, 2))
      FROM puddle_stats l ASOF JOIN rpi_stats_hwmon r
      WHERE l.timestamp >= $START
        AND l.timestamp <= $END
      SAMPLE BY $SAMPLE_BY
    `.replace(/\s+/g, ' ').trim(),
    series: [
      { label: "RPi CPU" },
      { label: "Drive" },
      { label: "Motor" },
    ],
    yDomain: [0, 80],
    yLabel: "Temperature (°C)",
  },
  {
    title: "Motor Current",
    query: `
      SELECT timestamp,
        avg(motor_current / 1000.0), min(motor_current / 1000.0), max(motor_current / 1000.0)
      FROM puddle_stats
      WHERE timestamp >= $START
        AND timestamp <= $END
      SAMPLE BY $SAMPLE_BY
    `.replace(/\s+/g, ' ').trim(),
    series: [
      { label: "Current" },
    ],
    yDomain: [null, null],
    initialYDomain: [-5, 5],
    yCenterZero: true,
    yLabel: "Amperes (A)",
  },
  {
    title: "Motor Position",
    query: `
      SELECT timestamp,
        avg(demand_position / 10000.0), min(demand_position / 10000.0), max(demand_position / 10000.0)
      FROM puddle_stats
      WHERE timestamp >= $START
        AND timestamp <= $END
      SAMPLE BY $SAMPLE_BY
    `.replace(/\s+/g, ' ').trim(),
    series: [
      { label: "Demand" },
      // { label: "Actual" },
    ],
    yDomain: [null, null],
    initialYDomain: [0, 360],
    yLabel: "Position (mm)",
  },
  {
    title: "Position Accuracy",
    query: `
      SELECT timestamp,
        avg((demand_position - actual_position) / 10000.0), min((demand_position - actual_position) / 10000.0), max((demand_position - actual_position) / 10000.0)
      FROM puddle_stats
      WHERE timestamp >= $START
        AND timestamp <= $END
      SAMPLE BY $SAMPLE_BY
    `.replace(/\s+/g, ' ').trim(),
    series: [
      { label: "Offset" },
    ],
    yDomain: [null, null],
    initialYDomain: [-2, 2],
    yCenterZero: true,
    yLabel: "Position (mm)",
  },
  {
    title: "Demand Velocity",
    query: `
      SELECT timestamp,
        avg(demand_velocity / 1000000.0), min(demand_velocity / 1000000.0), max(demand_velocity / 1000000.0)
      FROM puddle_stats
      WHERE timestamp >= $START
        AND timestamp <= $END
      SAMPLE BY $SAMPLE_BY
    `.replace(/\s+/g, ' ').trim(),
    series: [
      { label: "Demand Velocity" },
    ],
    yDomain: [null, null],
    initialYDomain: [-2, 2],
    yCenterZero: true,
    yLabel: "Velocity (m/s)",
  },
  {
    title: "Demand Acceleration",
    query: `
      SELECT timestamp,
        avg(demand_acceleration / 100000.0), min(demand_acceleration / 100000.0), max(demand_acceleration / 100000.0)
      FROM puddle_stats
      WHERE timestamp >= $START
        AND timestamp <= $END
      SAMPLE BY $SAMPLE_BY
    `.replace(/\s+/g, ' ').trim(),
    series: [
      { label: "Demand Acceleration" },
    ],
    yDomain: [null, null],
    initialYDomain: [-2, 2],
    yCenterZero: true,
    yLabel: "Acceleration (m/s\u00B2)",
  },
];

function roundToNearest(value: number, step: number) {
  return Math.max(step, Math.round(value / step) * step);
}

function getQueryBucketMs(range: SelectedRange, plotWidthPx: number) {
  const rangeMs = Math.max(1, range.end.getTime() - range.start.getTime());
  const targetMs = Math.max(1, rangeMs / Math.max(1, plotWidthPx));

  if (targetMs < 10) return 1;
  if (targetMs < 100) return roundToNearest(targetMs, 5);
  if (targetMs < 1000) return roundToNearest(targetMs, 50);
  if (targetMs < 60_000) return roundToNearest(targetMs, 1000);
  return roundToNearest(targetMs, 60_000);
}

function formatSampleByInterval(bucketMs: number) {
  if (bucketMs % 3_600_000 === 0) return `${bucketMs / 3_600_000}h`;
  if (bucketMs % 60_000 === 0) return `${bucketMs / 60_000}m`;
  if (bucketMs % 1000 === 0) return `${bucketMs / 1000}s`;
  return `${bucketMs}T`;
}

export default function Monitor() {
  const [selectedRange, setSelectedRange] = useState<SelectedRange | null>(null);
  const [liveDurationMs, setLiveDurationMs] = useState(LIVE_DURATION_OPTIONS[0].ms);
  const liveDurationMsRef = useRef(LIVE_DURATION_OPTIONS[0].ms);
  const [liveRange, setLiveRange] = useState<SelectedRange>(() => ({
    start: new Date(Date.now() - LIVE_DURATION_OPTIONS[0].ms),
    end: new Date(),
  }));
  const [refreshKey, setRefreshKey] = useState(0);
  const [samplingIntervalMs, setSamplingIntervalMs] = useState(2);
  const effectiveRange = selectedRange ?? liveRange;

  const handleLiveDurationChange = useCallback((ms: number) => {
    liveDurationMsRef.current = ms;
    setLiveDurationMs(ms);
  }, []);

  const refreshCharts = useCallback(() => {
    setLiveRange({
      start: new Date(Date.now() - liveDurationMsRef.current),
      end: new Date(),
    });
    setRefreshKey(k => k + 1);
  }, []);

  const handleBrushEnd = useCallback((range: SelectedRange) => {
    setSelectedRange(range);
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    const detectSamplingInterval = async () => {
      try {
        const query = 'SELECT timestamp FROM puddle_stats ORDER BY timestamp DESC LIMIT 1000';
        const response = await fetch('/questdb/exec?' + new URLSearchParams({
          nm: 'true',
          query,
        }), {
          signal: abortController.signal,
        });

        if (!response.ok) {
          console.warn(`Failed to detect sampling interval: ${response.status}`);
          return;
        }

        const body: QuestDbResponse = await response.json();
        const dataset = body.dataset || [];

        if (dataset.length < 10) {
          console.warn('Not enough samples to detect interval; using default 2ms');
          return;
        }

        const timestamps = dataset
          .map(row => new Date(row[0]).getTime())
          .sort((a, b) => a - b);

        const deltas: number[] = [];
        for (let i = 1; i < timestamps.length; i++) {
          const delta = timestamps[i] - timestamps[i - 1];
          if (delta > 0) {
            deltas.push(delta);
          }
        }

        if (deltas.length === 0) {
          console.warn('All timestamps are identical; using default 2ms');
          return;
        }

        deltas.sort((a, b) => a - b);
        const median = deltas[Math.floor(deltas.length / 2)];
        setSamplingIntervalMs(median);
        console.log(`Detected sampling interval: ${median}ms`);
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.warn('Failed to detect sampling interval:', err);
        }
      }
    };

    detectSamplingInterval();

    return () => {
      abortController.abort();
    };
  }, []);

  return (
    <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8 w-full">
      <div className="p-6 flex flex-col gap-8">
        <DateRangeSelector
          value={selectedRange}
          onChange={setSelectedRange}
          onRefresh={refreshCharts}
          liveDurationMs={liveDurationMs}
          onLiveDurationChange={handleLiveDurationChange}
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {DEFAULT_CHARTS.map((config, idx) => (
            <Chart key={idx} config={config} range={effectiveRange} refreshKey={refreshKey} onBrushEnd={handleBrushEnd} samplingIntervalMs={samplingIntervalMs}/>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatDateKeyLocal(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfHourInclusive(date: Date) {
  return new Date(date.getTime() + (60 * 60 * 1000) - 1);
}

function rangeLabel(range: SelectedRange | null) {
  if (!range) return "Live mode";
  return `${range.start.toLocaleString()} - ${range.end.toLocaleString()}`;
}

function aggregateValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function computeIntensityMap(entries: [string, number | null][]) {
  const intensities = new Map<string, number>();

  if (entries.length === 0) {
    return intensities;
  }

  const normalizedValues = entries.map(([, value]) => aggregateValue(value));
  const positiveValues = normalizedValues.filter(value => value > 0);

  if (positiveValues.length === 0) {
    for (const [key] of entries) {
      intensities.set(key, 0);
    }
    return intensities;
  }

  const minPositive = Math.min(...positiveValues);
  const maxPositive = Math.max(...positiveValues);
  const logMin = Math.log10(minPositive);
  const logMax = Math.log10(maxPositive);

  for (let i = 0; i < entries.length; i += 1) {
    const [key] = entries[i];
    const value = normalizedValues[i];

    if (value <= 0) {
      intensities.set(key, 0);
      continue;
    }

    if (logMin === logMax) {
      intensities.set(key, 0.7);
      continue;
    }

    const normalized = (Math.log10(value) - logMin) / (logMax - logMin);
    const bounded = Math.max(0, Math.min(1, normalized));
    intensities.set(key, MIN_AVAILABLE_INTENSITY + bounded * (1 - MIN_AVAILABLE_INTENSITY));
  }

  return intensities;
}

function intensityTier(intensity: number) {
  if (intensity >= 0.82) return 4;
  if (intensity >= 0.64) return 3;
  if (intensity >= 0.46) return 2;
  if (intensity >= 0.28) return 1;
  return 0;
}

function createTimelineBins(
  dayStart: Date,
  hourlyValues: Map<string, number | null>,
  hourlyBounds: Map<string, { dataStart: Date | null; dataEnd: Date | null }>,
  hourlyIntensities: Map<string, number>,
  rowSize: number,
) {
  const totalBins = 24 + 2 * rowSize;
  const bins: TimelineBin[] = [];

  for (let idx = 0; idx < totalBins; idx += 1) {
    const hourStart = new Date(dayStart.getTime() + (idx - rowSize) * 60 * 60 * 1000);
    const key = hourStart.toISOString();
    const isAvailable = hourlyValues.has(key);
    const bounds = hourlyBounds.get(key);
    bins.push({
      start: hourStart,
      end: endOfHourInclusive(hourStart),
      dataStart: bounds?.dataStart ?? null,
      dataEnd: bounds?.dataEnd ?? null,
      isAvailable,
      intensity: isAvailable ? (hourlyIntensities.get(key) ?? 0) : 0,
    });
  }

  // Contiguity filter for before-overflow (indices 0..rowSize-1):
  // Walk backward from the day boundary; any unavailable bin stops the chain.
  let chain = true;
  for (let idx = rowSize - 1; idx >= 0; idx -= 1) {
    if (!bins[idx].isAvailable) chain = false;
    if (!chain) bins[idx] = { ...bins[idx], isAvailable: false, intensity: 0, dataStart: null, dataEnd: null };
  }

  // Contiguity filter for after-overflow (indices rowSize+24..totalBins-1):
  // Walk forward from the day boundary; any unavailable bin stops the chain.
  chain = true;
  for (let idx = rowSize + 24; idx < totalBins; idx += 1) {
    if (!bins[idx].isAvailable) chain = false;
    if (!chain) bins[idx] = { ...bins[idx], isAvailable: false, intensity: 0, dataStart: null, dataEnd: null };
  }

  return bins;
}

function DateRangeSelector({
  value,
  onChange,
  onRefresh,
  liveDurationMs,
  onLiveDurationChange,
}: {
  value: SelectedRange | null;
  onChange: (range: SelectedRange | null) => void;
  onRefresh: () => void;
  liveDurationMs: number;
  onLiveDurationChange: (ms: number) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [loadingDays, setLoadingDays] = useState(false);
  const [loadingTimeline, setLoadingTimeline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableDayValues, setAvailableDayValues] = useState<Map<string, number | null>>(new Map());
  const [selectedDay, setSelectedDay] = useState<Date | undefined>(undefined);
  const [timelineBins, setTimelineBins] = useState<TimelineBin[]>([]);
  const [pendingStartIndex, setPendingStartIndex] = useState<number | null>(null);
  const popoverContainerRef = useRef<HTMLDivElement>(null);
  const dayIntensities = useMemo(
    () => computeIntensityMap(Array.from(availableDayValues.entries())),
    [availableDayValues],
  );

  // Close popover on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (!popoverContainerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen]);

  useEffect(() => {
    const abortController = new AbortController();

    const fetchAvailableDays = async () => {
      setLoadingDays(true);
      try {
        const query = `
          SELECT timestamp, sum(command_position)
          FROM puddle_stats
          SAMPLE BY 1d
        `.replace(/\s+/g, " ").trim();

        const response = await fetch('/questdb/exec?' + new URLSearchParams({
          nm: 'true',
          query,
        }), {
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const body: QuestDbResponse = await response.json();
        const values = new Map<string, number | null>();

        for (const row of body.dataset || []) {
          const date = new Date(row[0]);
          if (!Number.isNaN(date.getTime())) {
            values.set(formatDateKeyLocal(date), row[1] ?? null);
          }
        }

        setAvailableDayValues(values);

        if (values.size > 0) {
          // SAMPLE BY returns ascending order; take the last row for the newest day
          const lastRow = body.dataset[body.dataset.length - 1];
          const newest = lastRow?.[0] ? new Date(lastRow[0]) : null;
          if (newest && !Number.isNaN(newest.getTime())) {
            setSelectedDay(prev => prev ?? newest);
          }
        }

        setError(null);
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Error fetching available days:", err);
          setError(err.message);
        }
      } finally {
        setLoadingDays(false);
      }
    };

    fetchAvailableDays();

    return () => {
      abortController.abort();
    };
  }, []);

  useEffect(() => {
    if (!selectedDay) {
      setTimelineBins([]);
      return;
    }

    const abortController = new AbortController();

    const fetchTimeline = async () => {
      setLoadingTimeline(true);

      try {
        const dayStart = startOfLocalDay(selectedDay);
        const windowStart = new Date(dayStart.getTime() - TIMELINE_ROW_SIZE * 60 * 60 * 1000);
        const windowEnd = new Date(dayStart.getTime() + (24 + TIMELINE_ROW_SIZE) * 60 * 60 * 1000);

        const query = `SELECT timestamp, sum(command_position), min(timestamp), max(timestamp) FROM puddle_stats WHERE timestamp >= '${windowStart.toISOString()}' AND timestamp < '${windowEnd.toISOString()}' SAMPLE BY 1h`;

        const response = await fetch('/questdb/exec?' + new URLSearchParams({
          nm: 'true',
          query,
        }), {
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const body: QuestDbResponse = await response.json();
        const hourlyValues = new Map<string, number | null>();
        const hourlyBounds = new Map<string, { dataStart: Date | null; dataEnd: Date | null }>();

        // SAMPLE BY 1h returns one row per UTC hour bucket with aggregate value.
        // Convert the UTC bucket timestamp to a local-time hour start so it
        // matches the bins built by createTimelineBins (which uses local time).
        for (const row of body.dataset || []) {
          const typedRow = row as unknown as [string, number | null, string | null, string | null];
          const bucketUtc = new Date(row[0]);
          if (!Number.isNaN(bucketUtc.getTime())) {
            const localHourStart = new Date(
              bucketUtc.getFullYear(),
              bucketUtc.getMonth(),
              bucketUtc.getDate(),
              bucketUtc.getHours(),
              0,
              0,
              0,
            );
            const dataStart = typedRow[2] ? new Date(typedRow[2]) : null;
            const dataEnd = typedRow[3] ? new Date(typedRow[3]) : null;
            hourlyValues.set(localHourStart.toISOString(), typedRow[1] ?? null);
            hourlyBounds.set(localHourStart.toISOString(), {
              dataStart: dataStart && !Number.isNaN(dataStart.getTime()) ? dataStart : null,
              dataEnd: dataEnd && !Number.isNaN(dataEnd.getTime()) ? dataEnd : null,
            });
          }
        }

        const hourlyIntensities = computeIntensityMap(Array.from(hourlyValues.entries()));
        setTimelineBins(createTimelineBins(dayStart, hourlyValues, hourlyBounds, hourlyIntensities, TIMELINE_ROW_SIZE));
        setPendingStartIndex(null);
        onChange(null);
        setError(null);
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error("Error fetching timeline:", err);
          setError(err.message);
        }
      } finally {
        setLoadingTimeline(false);
      }
    };

    fetchTimeline();

    return () => {
      abortController.abort();
    };
  }, [selectedDay, onChange]);

  const dayHasData = useCallback((date: Date) => {
    return availableDayValues.has(formatDateKeyLocal(date));
  }, [availableDayValues]);

  const dayTier = useCallback((date: Date) => {
    const key = formatDateKeyLocal(date);
    const intensity = dayIntensities.get(key);
    if (intensity === undefined) return -1;
    if (intensity === 0) return 5;
    return intensityTier(intensity);
  }, [dayIntensities]);

  const selectedIndexRange = useMemo(() => {
    if (!value) return null;

    let startIndex = -1;
    let endIndex = -1;

    for (let idx = 0; idx < timelineBins.length; idx += 1) {
      const bin = timelineBins[idx];
      if (startIndex === -1 && value.start >= bin.start && value.start <= bin.end) {
        startIndex = idx;
      }
      if (value.end >= bin.start && value.end <= bin.end) {
        endIndex = idx;
      }
    }

    if (startIndex === -1 || endIndex === -1) return null;
    return [Math.min(startIndex, endIndex), Math.max(startIndex, endIndex)] as const;
  }, [timelineBins, value]);

  const handleBinClick = useCallback((index: number) => {
    const candidate = timelineBins[index];
    if (!candidate?.isAvailable) {
      return;
    }

    if (pendingStartIndex === null) {
      setPendingStartIndex(index);
      return;
    }

    const start = Math.min(pendingStartIndex, index);
    const end = Math.max(pendingStartIndex, index);

    for (let idx = start; idx <= end; idx += 1) {
      if (!timelineBins[idx].isAvailable) {
        setPendingStartIndex(index);
        return;
      }
    }

    onChange({
      start: timelineBins[start].dataStart ?? timelineBins[start].start,
      end: timelineBins[end].dataEnd ?? timelineBins[end].end,
    });
    setPendingStartIndex(null);
    setIsOpen(false);
  }, [onChange, pendingStartIndex, timelineBins]);

  const activeOption = LIVE_DURATION_OPTIONS.find(o => o.ms === liveDurationMs) ?? LIVE_DURATION_OPTIONS[0];
  const rangeDisplay = value ? rangeLabel(value) : `Live: last ${activeOption.label}`;

  return (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-700">Time Range</h2>
          <p className="text-sm text-gray-500">{rangeDisplay}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Live duration pills */}
          <div className="flex items-center gap-1 rounded-lg border border-gray-200 p-1">
            <span className="px-2 text-xs text-gray-400 font-medium select-none">Live</span>
            {LIVE_DURATION_OPTIONS.map(opt => (
              <button
                key={opt.ms}
                type="button"
                onClick={() => {
                  onLiveDurationChange(opt.ms);
                  onChange(null);
                  setPendingStartIndex(null);
                  onRefresh();
                }}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  liveDurationMs === opt.ms && !value
                    ? "bg-gray-800 text-white"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Historical date picker popover */}
          <div className="relative" ref={popoverContainerRef}>
            <button
              type="button"
              onClick={() => setIsOpen(open => !open)}
              className={`px-3 py-2 text-sm font-medium border rounded-lg hover:bg-gray-50 ${
                isOpen || value ? "border-gray-800 bg-gray-50" : "border-gray-300"
              }`}
            >
              {value ? "Historical ▾" : "Select date ▾"}
            </button>
            {isOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-xl shadow-xl border border-gray-200 p-4 flex gap-4 min-w-max">
                {/* Calendar column */}
                <div>
                  {loadingDays ? (
                    <div className="w-[280px] flex items-center justify-center h-48 text-sm text-gray-500">
                      Loading available days...
                    </div>
                  ) : (
                    <DayPicker
                      mode="single"
                      selected={selectedDay}
                      onSelect={setSelectedDay}
                      disabled={(date) => !dayHasData(date)}
                      modifiers={{
                        levelZero: (date) => dayTier(date) === 5,
                        level0: (date) => dayTier(date) === 0,
                        level1: (date) => dayTier(date) === 1,
                        level2: (date) => dayTier(date) === 2,
                        level3: (date) => dayTier(date) === 3,
                        level4: (date) => dayTier(date) === 4,
                      }}
                      modifiersClassNames={{
                        levelZero: "rdp-day_level-zero",
                        level0: "rdp-day_level-0",
                        level1: "rdp-day_level-1",
                        level2: "rdp-day_level-2",
                        level3: "rdp-day_level-3",
                        level4: "rdp-day_level-4",
                      }}
                    />
                  )}
                </div>

                {/* Hour grid column */}
                <div className="flex flex-col justify-center">
                  {loadingTimeline ? (
                    <div className="flex-1 flex items-center justify-center text-sm text-gray-500 w-59">
                      Loading hours...
                    </div>
                  ) : timelineBins.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-sm text-gray-500 w-59">
                      Select a day to view hours.
                    </div>
                  ) : (
                    <>
                      <p className="text-xs text-gray-500 mb-2">Click a start hour, then an end hour.</p>
                      <div className="grid grid-cols-6 gap-1">
                        {timelineBins.map((bin, idx) => {
                          const isOverflow = idx < TIMELINE_ROW_SIZE || idx >= TIMELINE_ROW_SIZE + 24;
                          const isInSelectedRange = selectedIndexRange
                            ? idx >= selectedIndexRange[0] && idx <= selectedIndexRange[1]
                            : false;
                          const isPending = pendingStartIndex === idx;
                          const hour = String(bin.start.getHours()).padStart(2, "0");
                          // Overflow cells with no selectable data are hidden but keep grid space
                          if (isOverflow && !bin.isAvailable) {
                            return <div key={bin.start.toISOString()} className="h-9 w-9" />;
                          }
                          const levelClass = !bin.isAvailable
                            ? "border-gray-200 bg-gray-100 text-gray-300 cursor-not-allowed"
                            : bin.intensity === 0
                              ? `timeline-level-zero hover:brightness-95 ${isOverflow ? "opacity-60" : ""}`
                              : `timeline-level-${intensityTier(bin.intensity)} hover:brightness-95 ${isOverflow ? "opacity-60" : ""}`;
                          return (
                            <button
                              key={bin.start.toISOString()}
                              type="button"
                              onClick={() => handleBinClick(idx)}
                              title={`${bin.start.toLocaleString()} – ${bin.end.toLocaleTimeString()}`}
                              disabled={!bin.isAvailable}
                              className={`h-9 w-9 rounded-sm border flex items-center justify-center font-mono ${levelClass} ${isInSelectedRange ? "ring-2 ring-red-500" : ""} ${isPending ? "ring-2 ring-blue-500" : ""}`}
                            >
                              <span className="text-[11px]">{hour}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <style>{`
        .rdp-day_level-zero > .rdp-day_button { background-color: #f3f4f6; color: #6b7280; font-weight: 600; }
        .rdp-day_level-0 > .rdp-day_button { background-color: #fff1f2; color: #881337; font-weight: 600; }
        .rdp-day_level-1 > .rdp-day_button { background-color: #ffe4e6; color: #881337; font-weight: 600; }
        .rdp-day_level-2 > .rdp-day_button { background-color: #fecdd3; color: #881337; font-weight: 600; }
        .rdp-day_level-3 > .rdp-day_button { background-color: #fda4af; color: #7f1d1d; font-weight: 600; }
        .rdp-day_level-4 > .rdp-day_button { background-color: #fb7185; color: #7f1d1d; font-weight: 700; }

        .timeline-level-zero { border-color: #d1d5db; background-color: #f9fafb; color: #6b7280; }
        .timeline-level-0 { border-color: #fecdd3; background-color: #fff1f2; color: #881337; }
        .timeline-level-1 { border-color: #fda4af; background-color: #ffe4e6; color: #881337; }
        .timeline-level-2 { border-color: #fb7185; background-color: #fecdd3; color: #881337; }
        .timeline-level-3 { border-color: #f43f5e; background-color: #fda4af; color: #7f1d1d; }
        .timeline-level-4 { border-color: #e11d48; background-color: #fb7185; color: #7f1d1d; }

        .brush .selection {
          fill: #9B111E;
          fill-opacity: 0.15;
          stroke: #9B111E;
          stroke-width: 1px;
        }
      `}</style>
    </div>
  );
}

function Chart({ config, range, refreshKey, onBrushEnd, samplingIntervalMs }: { config: ChartConfig; range: SelectedRange; refreshKey: number; onBrushEnd?: (range: SelectedRange) => void; samplingIntervalMs: number }) {
  const [data, setData] = useState<[number, ...(number | null)[]][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [plotWidthPx, setPlotWidthPx] = useState(DEFAULT_CHART_WIDTH_PX);
  const frameRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!frameRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0) return;
      const nextWidth = Math.max(1, Math.round(entries[0].contentRect.width - CHART_PLOT_HORIZONTAL_MARGIN_PX));
      setPlotWidthPx((currentWidth) => currentWidth === nextWidth ? currentWidth : nextWidth);
    });

    resizeObserver.observe(frameRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const queryBucketMs = useMemo(() => {
    const rawBucket = getQueryBucketMs(range, plotWidthPx);
    return Math.max(samplingIntervalMs, rawBucket);
  }, [range, plotWidthPx, samplingIntervalMs]);
  const sampleByInterval = useMemo(() => formatSampleByInterval(queryBucketMs), [queryBucketMs]);

  useEffect(() => {
    const abortController = new AbortController();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const fetchData = async () => {
      setIsLoading(true);

      try {
        const startExpression = `'${range.start.toISOString()}'`;
        const endExpression = `'${range.end.toISOString()}'`;

        const executableQuery = config.query
          .replace('$START', startExpression)
          .replace('$END', endExpression)
          .replace('$SAMPLE_BY', sampleByInterval);

        const response = await fetch('/questdb/exec?' + new URLSearchParams({
          nm: 'true',
          query: executableQuery,
        }), {
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        const body: QuestDbResponse = await response.json();
        const rawDataset = body.dataset || [];

        const newDataset = rawDataset.map(row => [
          new Date(row[0]).getTime(),
          ...row.slice(1)
        ] as [number, ...(number | null)[]]);

        if (requestId === requestIdRef.current) {
          setData(newDataset);
          setError(null);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError' && requestId === requestIdRef.current) {
          console.error('Error fetching data:', err);
          setError(err.message);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    };

    fetchData();

    return () => {
      abortController.abort();
    };
  }, [config.query, range, refreshKey, sampleByInterval]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-700 px-1">{config.title}</h2>
      <div ref={frameRef} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 overflow-hidden relative">
        {isLoading && (
          <div className="absolute top-3 right-3 z-10 pointer-events-none rounded-full border border-gray-200 bg-white/90 px-2.5 py-1 text-xs font-medium text-gray-600 shadow-sm">
            Loading...
          </div>
        )}
        {error && (
          <div className="absolute z-10 left-0 right-0 pointer-events-none">
            <div
              className="mx-auto w-1/2 rounded-md bg-red-50 border border-red-200 text-red-700 px-4 py-3 shadow-lg text-sm font-medium text-center">
              {error}
            </div>
          </div>
        )}
        <LineChart
          data={data}
          series={config.series}
          yDomain={config.yDomain}
          initialYDomain={config.initialYDomain}
          yCenterZero={config.yCenterZero}
          yLabel={config.yLabel}
          gapThresholdMs={queryBucketMs}
          fixedTimeRange={range}
          onBrushEnd={onBrushEnd}
          className="h-64"
        />
        <div className="mt-4 flex flex-wrap gap-6 justify-center text-sm font-medium">
          {config.series.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full"
                   style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}></div>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface LineChartProps {
  data: [number, ...(number | null)[]][];
  series: SeriesConfig[];
  yDomain?: [number | null, number | null];
  initialYDomain?: [number, number];
  yCenterZero?: boolean;
  yLabel?: string;
  gapThresholdMs: number;
  className?: string;
  fixedTimeRange: SelectedRange;
  onBrushEnd?: (range: SelectedRange) => void;
}

function LineChart({
                     data,
                     series,
                     yDomain = [0, 80],
                     initialYDomain = [0, 100],
                     yCenterZero = false,
                     yLabel,
                     gapThresholdMs,
                     className = "h-64",
                     fixedTimeRange,
                     onBrushEnd,
                   }: LineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const chartIdRef = useRef(`chart-${Math.random().toString(36).slice(2, 11)}`);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const xScaleRef = useRef<d3.ScaleTime<number, number> | null>(null);
  const brushGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const onBrushEndRef = useRef(onBrushEnd);
  useEffect(() => { onBrushEndRef.current = onBrushEnd; }, [onBrushEnd]);

  // Constants
  const fadeMargin = 5;
  const margin = { top: 5, left: 45, bottom: 20, right: 20 };



  const processedData = useMemo(() => {
    if (data.length < 2) return data;

    const result: [number, ...(number | null)[]][] = [];
    for (let i = 0; i < data.length; i++) {
      if (i > 0) {
        const prevTime = data[i - 1][0];
        const currTime = data[i][0];

        if (currTime - prevTime > gapThresholdMs * 1.5) {
          const breakTime = prevTime + gapThresholdMs;
          result.push([breakTime, ...new Array(data[i].length - 1).fill(null)]);
        }
      }
      result.push(data[i]);
    }
    return result;
  }, [data, gapThresholdMs]);

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length > 0) {
        const { width, height } = entries[0].contentRect;
        setDimensions({ width, height });
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const updateAxes = useCallback((
    g: d3.Selection<SVGGElement, unknown, null, undefined>,
    y: d3.ScaleLinear<number, number>,
    innerWidth: number,
    innerHeight: number,
    xDomainStart: number,
    xDomainEnd: number,
  ) => {
    // X-axis scale (extended for fading)
    const domainDurationMs = Math.max(1, xDomainEnd - xDomainStart);
    const timePerPixel = domainDurationMs / innerWidth;
    const xAxisScale = d3.scaleTime()
      .domain([xDomainStart - (fadeMargin * timePerPixel), xDomainEnd + (fadeMargin * timePerPixel)])
      .range([-fadeMargin, innerWidth + fadeMargin]);

    const xAxis = d3.axisBottom(xAxisScale)
      .ticks(Math.max(2, Math.floor(innerWidth / 80)))
      .tickFormat(d3.timeFormat("%H:%M:%S") as any);

    const yTickCount = Math.max(2, Math.floor(innerHeight / 40));
    const yTicks = y.ticks(yTickCount);

    const yGrid = d3.axisLeft(y)
      .tickValues(yTicks)
      .tickSize(-innerWidth)
      .tickFormat(() => "");

    const yGridG = g.select<SVGGElement>(".y-grid").call(yGrid);

    yGridG.selectAll("line")
      .attr("stroke", "#9ca3af")
      .attr("stroke-opacity", 0.2)
      .attr("shape-rendering", "crispEdges");
    yGridG.select(".domain").attr("display", "none");

    const xAxisG = g.select<SVGGElement>(".x-axis")
      .attr("transform", `translate(0,${innerHeight})`)
      .call(xAxis);

    xAxisG.select(".domain").attr("display", "none");

    // Fade in/out X-axis labels
    xAxisG.selectAll(".tick").each(function () {
      const tick = d3.select(this);
      const transform = tick.attr("transform");
      const match = transform ? transform.match(/translate\(([^,]+),/) : null;
      if (match) {
        const xPos = parseFloat(match[1]);
        let opacity = 1.0;
        if (xPos < 0) {
          opacity = 1.0 - (Math.abs(xPos) / fadeMargin);
        } else if (xPos > innerWidth) {
          opacity = 1.0 - ((xPos - innerWidth) / fadeMargin);
        }
        tick.attr("opacity", Math.max(0, Math.min(1, opacity)));
      }
    });

    // Y-axis
    g.select<SVGGElement>(".y-axis").call(d3.axisLeft(y).tickValues(yTicks));

    // Major X-axis line at y(0)
    const xMajor = g.select<SVGLineElement>("line.x-axis-major");
    const yZero = y(0);
    const yPos = (yZero >= 0 && yZero <= innerHeight) ? yZero : innerHeight;
    xMajor
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", yPos)
      .attr("y2", yPos);
  }, []);

  const updatePaths = useCallback((
    envelopeGroup: d3.Selection<SVGGElement, unknown, null, undefined>,
    seriesGroup: d3.Selection<SVGGElement, unknown, null, undefined>,
    x: d3.ScaleTime<number, number>,
    y: d3.ScaleLinear<number, number>,
    renderData: [number, ...(number | null)[]][]
  ) => {
    if (renderData.length === 0) return;

    // Envelope areas (min/max band)
    const area = d3.area<[number, ...(number | null)[]]>()
      .x(d => x(d[0]));

    envelopeGroup.selectAll<SVGPathElement, SeriesConfig>("path").each(function (_, i) {
      const avgIdx = 1 + 3 * i;
      const minIdx = 2 + 3 * i;
      const maxIdx = 3 + 3 * i;
      area
        .defined(d => typeof d[avgIdx] === 'number' && typeof d[minIdx] === 'number' && typeof d[maxIdx] === 'number')
        .y0(d => y(d[minIdx] as number))
        .y1(d => y(d[maxIdx] as number));
      d3.select(this).attr("d", area(renderData));
    });

    // Avg lines
    const line = d3.line<[number, ...(number | null)[]]>()
      .x(d => x(d[0]));

    seriesGroup.selectAll<SVGPathElement, SeriesConfig>("path").each(function (this: SVGPathElement, _, i) {
      const avgIdx = 1 + 3 * i;
      line
        .defined(d => typeof d[avgIdx] === 'number')
        .y(d => y(d[avgIdx] as number));
      d3.select(this).attr("d", line(renderData));
    });
  }, []);

  useEffect(() => {
    if (!svgRef.current || dimensions.width === 0 || dimensions.height === 0) return;

    const { width, height } = dimensions;
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    let g = svg.select<SVGGElement>("g.container");

    if (g.empty()) {
      g = svg.append("g")
        .attr("class", "container")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      g.append("g").attr("class", "y-grid");
      g.append("g").attr("class", "x-axis text-[10px] font-medium");
      g.append("line").attr("class", "x-axis-major").attr("stroke", "currentColor");
      g.append("g").attr("class", "y-axis text-[10px] font-medium");

      if (yLabel) {
        g.append("text")
          .attr("class", "y-axis-label text-[10px] font-medium")
          .attr("transform", "rotate(-90)")
          .attr("y", -margin.left + 5)
          .attr("text-anchor", "middle")
          .text(yLabel);
      }

      g.append("clipPath")
        .attr("id", `${chartIdRef.current}-clip`)
        .append("rect")
        .attr("transform", "translate(0.5,-0.5)");

      const seriesContainer = g.append("g")
        .attr("class", "series-container")
        .attr("clip-path", `url(#${chartIdRef.current}-clip)`);

      seriesContainer.append("g")
        .attr("class", "envelope");

      seriesContainer.append("g")
        .attr("class", "series")
        .attr("fill", "none")
        .attr("stroke-width", 1.5)
        .attr("stroke-linejoin", "round");

      brushGRef.current = g.append("g").attr("class", "brush");
    }

    g.select<SVGRectElement>(`#${chartIdRef.current}-clip rect`)
      .attr("width", innerWidth)
      .attr("height", innerHeight);

    if (yLabel) {
      g.select<SVGTextElement>(".y-axis-label")
        .attr("x", -innerHeight / 2);
    }

    const envelopeGroup = g.select<SVGGElement>(".envelope");
    envelopeGroup.selectAll<SVGPathElement, SeriesConfig>("path")
      .data(series)
      .join("path")
      .attr("fill", (_, i) => CHART_COLORS[i % CHART_COLORS.length])
      .attr("fill-opacity", 0.15)
      .attr("stroke", "none");

    const seriesGroup = g.select<SVGGElement>(".series");
    seriesGroup.selectAll<SVGPathElement, SeriesConfig>("path")
      .data(series)
      .join("path")
      .attr("stroke", (_, i) => CHART_COLORS[i % CHART_COLORS.length]);

    const calculateYDomain = (): [number, number] => {
      let [yMin, yMax] = yDomain;
      if (yMin === null || yMax === null) {
        const allValues = data.flatMap(d => d.slice(1).filter(v => typeof v === 'number') as number[]);
        if (allValues.length > 0) {
          const [dataMin, dataMax] = d3.extent(allValues) as [number, number];
          if (yMin === null) yMin = dataMin;
          if (yMax === null) yMax = dataMax;
        } else {
          if (yMin === null) yMin = initialYDomain[0];
          if (yMax === null) yMax = initialYDomain[1];
        }
      }

      if (yCenterZero) {
        const absMax = Math.max(Math.abs(yMin as number), Math.abs(yMax as number));
        yMin = -absMax;
        yMax = absMax;
      }

      if (yMin === yMax) {
        yMin = (yMin as number) - 1;
        yMax = (yMax as number) + 1;
      }
      return [yMin as number, yMax as number];
    };

    const yDomainComputed = calculateYDomain();

    const xDomainStart = fixedTimeRange.start.getTime();
    const xDomainEnd = fixedTimeRange.end.getTime();
    const x = d3.scaleTime().domain([xDomainStart, xDomainEnd]).range([0, innerWidth]);
    const y = d3.scaleLinear().domain(yDomainComputed).range([innerHeight, 0]);

    updateAxes(g, y, innerWidth, innerHeight, xDomainStart, xDomainEnd);
    updatePaths(envelopeGroup, seriesGroup, x, y, processedData);

    xScaleRef.current = x;
    if (brushGRef.current) {
      const brush = d3.brushX<unknown>()
        .extent([[0, 0], [innerWidth, innerHeight]])
        .on("end", (event: d3.D3BrushEvent<unknown>) => {
          if (!event.selection) return;
          const [x0, x1] = event.selection as [number, number];
          const brushPixels = Math.abs(x1 - x0);
          if (brushPixels < 10) return;
          const scale = xScaleRef.current;
          if (!scale) return;
          const start = scale.invert(x0);
          const end = scale.invert(x1);
          onBrushEndRef.current?.({ start, end });
          brushGRef.current!.call(brush.move, null);
        });
      brushGRef.current.call(brush);
    }

  }, [data, processedData, series, yDomain, dimensions, fixedTimeRange, initialYDomain, yCenterZero, updateAxes, updatePaths]);

  return (
    <div ref={containerRef} className={`w-full relative ${className}`}>
      <svg
        width={dimensions.width}
        height={dimensions.height}
        ref={svgRef}
        className="overflow-visible absolute inset-0"
      />
    </div>
  );
}
