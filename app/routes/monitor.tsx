import type { Route } from "./+types/monitor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

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
  interval: number;
  series: SeriesConfig[];
  yDomain?: [number | null, number | null];
  initialYDomain?: [number, number];
  yCenterZero?: boolean;
  yLabel?: string;
  durationSeconds: number;
  sampleIntervalMs?: number;
  className?: string;
}

interface QuestDbResponse {
  query: string;
  columns: { name: string; type: string }[];
  dataset: [string, ...(number | null)[]][];
  count: number;
}

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
      SELECT r.timestamp,
        r.cpu_thermal_temp / 1000.0,
        l.drive_temp / 10.0,
        round((l.motor_temp * (50.0 / 51.0)) - 50.0, 2)
      FROM rpi_stats_hwmon r ASOF JOIN linmot_stats l
      WHERE r.timestamp >= $START
    `.replace(/\s+/g, ' ').trim(),
    interval: 1000,
    durationSeconds: 5 * 60,
    series: [
      { label: "RPi CPU" },
      { label: "Drive" },
      { label: "Motor" },
    ],
    yDomain: [0, 80],
    yLabel: "Temperature (°C)",
    sampleIntervalMs: 1000,
  },
  {
    title: "Motor Current",
    query: `
      SELECT timestamp,
        current / 1000.0
      FROM linmot_stats
      WHERE timestamp >= $START
    `.replace(/\s+/g, ' ').trim(),
    interval: 250,
    durationSeconds: 60,
    series: [
      { label: "Current" },
    ],
    yDomain: [null, null],
    initialYDomain: [-5, 5],
    yCenterZero: true,
    yLabel: "Amperes (A)",
    sampleIntervalMs: 10,
  },
  {
    title: "Motor Position",
    query: `
      SELECT timestamp,
        demand_position / 10000.0,
        /* actual_position / 10000.0, */
      FROM linmot_stats
      WHERE timestamp >= $START
    `.replace(/\s+/g, ' ').trim(),
    interval: 250,
    durationSeconds: 60,
    series: [
      { label: "Demand" },
      // { label: "Actual" },
    ],
    yDomain: [null, null],
    initialYDomain: [0, 360],
    yLabel: "Position (mm)",
    sampleIntervalMs: 10,
  },
  {
    title: "Position Accuracy",
    query: `
      SELECT timestamp,
        (demand_position - actual_position) / 10000.0,
      FROM linmot_stats
      WHERE timestamp >= $START
    `.replace(/\s+/g, ' ').trim(),
    interval: 250,
    durationSeconds: 60,
    series: [
      { label: "Offset" },
    ],
    yDomain: [null, null],
    initialYDomain: [-2, 2],
    yCenterZero: true,
    yLabel: "Position (mm)",
    sampleIntervalMs: 10,
  },
  {
    title: "Demand Velocity",
    query: `
      SELECT timestamp,
        demand_velocity / 1000000.0,
      FROM linmot_stats
      WHERE timestamp >= $START
    `.replace(/\s+/g, ' ').trim(),
    interval: 250,
    durationSeconds: 60,
    series: [
      { label: "Demand Velocity" },
    ],
    yDomain: [null, null],
    initialYDomain: [-2, 2],
    yCenterZero: true,
    yLabel: "Velocity (m/s)",
    sampleIntervalMs: 10,
  },
  {
    title: "Demand Acceleration",
    query: `
      SELECT timestamp,
        demand_acceleration / 100000.0,
      FROM linmot_stats
      WHERE timestamp >= $START
    `.replace(/\s+/g, ' ').trim(),
    interval: 250,
    durationSeconds: 60,
    series: [
      { label: "Demand Acceleration" },
    ],
    yDomain: [null, null],
    initialYDomain: [-2, 2],
    yCenterZero: true,
    yLabel: "Acceleration (m/s\u00B2)",
    sampleIntervalMs: 10,
  },
];

export default function Monitor() {
  return (
    <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8 w-full">
      <div className="p-6 flex flex-col gap-8">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {DEFAULT_CHARTS.map((config, idx) => (
            <Chart key={idx} config={config}/>
          ))}
        </div>
      </div>
    </div>
  );
}

function Chart({ config }: { config: ChartConfig }) {
  const [data, setData] = useState<[number, ...(number | null)[]][]>([]);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);
  const lastTimestampRef = useRef<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();

    const fetchData = async () => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      try {
        let startExpression;
        if (lastTimestampRef.current) {
          // Fetch only data newer than the last timestamp received
          startExpression = `'${lastTimestampRef.current}'`;
        } else {
          // First fetch: get the full duration
          startExpression = `dateadd('s', -${config.durationSeconds}, now())`;
        }

        const executableQuery = config.query.replace('$START', startExpression);

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

        if (rawDataset.length > 0) {
          lastTimestampRef.current = rawDataset[rawDataset.length - 1][0];

          const newDataset = rawDataset.map(row => [
            new Date(row[0]).getTime(),
            ...row.slice(1)
          ] as [number, ...(number | null)[]]);

          setData((prevData) => {
            const combined = [...prevData, ...newDataset];

            // Client-side pruning: remove data points older than durationSeconds
            const cutoff = Date.now() - (config.durationSeconds * 1000);
            return combined.filter(row => row[0] >= cutoff);
          });
        }

        setError(null);
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.error('Error fetching data:', err);
          setError(err.message);
        }
      } finally {
        isFetchingRef.current = false;
      }
    };

    fetchData();
    const interval = setInterval(fetchData, config.interval);

    return () => {
      clearInterval(interval);
      abortController.abort();
    };
  }, [config.query, config.interval, config.durationSeconds]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-gray-700 px-1">{config.title}</h2>
      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 overflow-hidden relative">
        {error && (
          <div className="absolute z-10 left-0 right-0">
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
          durationSeconds={config.durationSeconds}
          sampleIntervalMs={config.sampleIntervalMs}
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
  durationSeconds: number;
  sampleIntervalMs?: number;
  className?: string;
}

function LineChart({
                     data,
                     series,
                     yDomain = [0, 80],
                     initialYDomain = [0, 100],
                     yCenterZero = false,
                     yLabel,
                     durationSeconds,
                     sampleIntervalMs,
                     className = "h-64"
                   }: LineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const chartIdRef = useRef(`chart-${Math.random().toString(36).slice(2, 11)}`);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // Constants
  const fadeMargin = 5;
  const margin = { top: 5, left: 45, bottom: 20, right: 20 };

  // Refs for D3 objects to use in animation loop
  const xRef = useRef<d3.ScaleTime<number, number> | null>(null);
  const yRef = useRef<d3.ScaleLinear<number, number> | null>(null);
  const dataRef = useRef(data);
  const seriesRef = useRef(series);

  // New refs for animating the reveal of new data
  const lastDataTimestampRef = useRef<number | null>(null);
  const virtualTimeRef = useRef<number | null>(null);

  // Refs for animating the Y-axis domain
  const targetYDomainRef = useRef<[number, number]>([0, 100]);
  const currentYDomainRef = useRef<[number, number]>([0, 100]);

  const processedData = useMemo(() => {
    if (!sampleIntervalMs || data.length < 2) return data;

    const result: [number, ...(number | null)[]][] = [];
    for (let i = 0; i < data.length; i++) {
      if (i > 0) {
        const prevTime = data[i - 1][0];
        const currTime = data[i][0];

        // If the gap is significantly larger than the interval (e.g., 1.5x)
        if (currTime - prevTime > sampleIntervalMs * 1.5) {
          // Insert a null-valued entry to break the line
          const breakTime = prevTime + sampleIntervalMs;
          result.push([breakTime, ...new Array(data[i].length - 1).fill(null)]);
        }
      }
      result.push(data[i]);
    }
    return result;
  }, [data, sampleIntervalMs]);

  useEffect(() => {
    if (processedData.length > 0) {
      const lastPoint = processedData[processedData.length - 1];
      const lastPointTime = lastPoint[0];

      if (lastDataTimestampRef.current === null) {
        // Initial load: start virtual time at the last point's time
        virtualTimeRef.current = lastPointTime;
      }

      lastDataTimestampRef.current = lastPointTime;
    }
    dataRef.current = processedData;
  }, [processedData]);

  useEffect(() => {
    seriesRef.current = series;
  }, [series]);

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
    now: number
  ) => {
    // X-axis scale (extended for fading)
    const timePerPixel = (durationSeconds * 1000) / innerWidth;
    const xAxisScale = d3.scaleTime()
      .domain([now - (durationSeconds * 1000) - (fadeMargin * timePerPixel), now + (fadeMargin * timePerPixel)])
      .range([-fadeMargin, innerWidth + fadeMargin]);

    const xAxis = d3.axisBottom(xAxisScale)
      .ticks(Math.max(2, Math.floor(innerWidth / 80)))
      .tickFormat(d3.timeFormat("%H:%M:%S") as any);

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
    g.select<SVGGElement>(".y-axis").call(d3.axisLeft(y));

    // Major X-axis line at y(0)
    const xMajor = g.select<SVGLineElement>("line.x-axis-major");
    const yZero = y(0);
    const yPos = (yZero >= 0 && yZero <= innerHeight) ? yZero : innerHeight;
    xMajor
      .attr("x1", 0)
      .attr("x2", innerWidth)
      .attr("y1", yPos)
      .attr("y2", yPos);
  }, [durationSeconds]);

  const updatePaths = useCallback((
    seriesGroup: d3.Selection<SVGGElement, unknown, null, undefined>,
    x: d3.ScaleTime<number, number>,
    y: d3.ScaleLinear<number, number>
  ) => {
    const currentData = dataRef.current;
    if (currentData.length === 0) return;

    const virtualTime = virtualTimeRef.current || Date.now();

    // Find the index of the first point that is > virtualTime using binary search
    let low = 0;
    let high = currentData.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (currentData[mid][0] <= virtualTime) low = mid + 1;
      else high = mid;
    }
    const visibleData = currentData.slice(0, low);
    if (visibleData.length === 0) return;

    // Create line generator once per frame and update its x/y scales
    const line = d3.line<[number, ...(number | null)[]]>()
      .x(d => x(d[0]));

    seriesGroup.selectAll<SVGPathElement, SeriesConfig>("path").each(function (this: SVGPathElement, _, i) {
      const idx = i + 1;
      line.defined(d => typeof d[idx] === 'number')
        .y(d => y(d[idx] as number));

      d3.select(this).attr("d", line(visibleData));
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
        .attr("class", "series")
        .attr("fill", "none")
        .attr("stroke-width", 1.5)
        .attr("stroke-linejoin", "round");
    }

    g.select<SVGRectElement>(`#${chartIdRef.current}-clip rect`)
      .attr("width", innerWidth)
      .attr("height", innerHeight);

    if (yLabel) {
      g.select<SVGTextElement>(".y-axis-label")
        .attr("x", -innerHeight / 2);
    }

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

    const targetYDomain = calculateYDomain();
    targetYDomainRef.current = targetYDomain;

    // Initialize currentYDomainRef if it hasn't been set yet
    if (currentYDomainRef.current[0] === 0 && currentYDomainRef.current[1] === 100) {
      currentYDomainRef.current = [...targetYDomain];
    }

    const now = Date.now();
    const x = d3.scaleTime().domain([now - (durationSeconds * 1000), now]).range([0, innerWidth]);
    const y = d3.scaleLinear().domain(currentYDomainRef.current).range([innerHeight, 0]);

    xRef.current = x;
    yRef.current = y;

    updateAxes(g, y, innerWidth, innerHeight, now);
    updatePaths(seriesGroup, x, y);

  }, [data, series, yDomain, dimensions, durationSeconds, initialYDomain, yCenterZero, updateAxes, updatePaths]);

  useEffect(() => {
    if (!svgRef.current || dimensions.width === 0 || dimensions.height === 0) return;

    const innerWidth = dimensions.width - margin.left - margin.right;
    const innerHeight = dimensions.height - margin.top - margin.bottom;
    const svg = d3.select(svgRef.current);
    const g = svg.select<SVGGElement>("g.container");
    const seriesGroup = g.select<SVGGElement>(".series");

    let rafId: number;
    let lastTick = Date.now();

    const animate = () => {
      const now = Date.now();
      const deltaTime = now - lastTick;
      lastTick = now;

      // Advance virtual time
      if (virtualTimeRef.current !== null && lastDataTimestampRef.current !== null) {
        if (virtualTimeRef.current < lastDataTimestampRef.current) {
          // If we're behind the data, catch up (revealing points smoothly)
          // Speed up slightly if we're far behind to ensure we eventually catch up
          const catchUpFactor = (lastDataTimestampRef.current - virtualTimeRef.current > 5000) ? 2 : 1;
          virtualTimeRef.current += deltaTime * catchUpFactor;

          if (virtualTimeRef.current > lastDataTimestampRef.current) {
            virtualTimeRef.current = lastDataTimestampRef.current;
          }
        } else {
          // If we're caught up, track current time
          virtualTimeRef.current = lastDataTimestampRef.current;
        }
      }

      const x = d3.scaleTime()
        .domain([now - (durationSeconds * 1000), now])
        .range([0, innerWidth]);

      xRef.current = x;

      // Interpolate Y-axis domain
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
      const t = 1 - Math.pow(0.01, deltaTime / 1000); // Smooth interpolation over ~1s

      currentYDomainRef.current[0] = lerp(currentYDomainRef.current[0], targetYDomainRef.current[0], t);
      currentYDomainRef.current[1] = lerp(currentYDomainRef.current[1], targetYDomainRef.current[1], t);

      const y = d3.scaleLinear().domain(currentYDomainRef.current).range([innerHeight, 0]);
      yRef.current = y;

      updateAxes(g, y, innerWidth, innerHeight, now);
      updatePaths(seriesGroup, x, y);

      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [dimensions, durationSeconds, updateAxes, updatePaths]);

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
