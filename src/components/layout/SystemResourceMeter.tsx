import {
  formatPercent,
  formatUsage,
  resourceLoadColor,
} from "../../core/resource-usage";
import { useResourceUsage } from "../../hooks/useResourceUsage";
import { IconCpu, IconDisk, IconMemory } from "../ui/Icons";

interface SystemResourceMeterProps {
  collapsed: boolean;
}

function MeterRow({
  icon,
  label,
  detail,
  percent,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  percent: number;
}) {
  return (
    <div className="resource-meter__row">
      <div className="resource-meter__head">
        <span className="resource-meter__icon">{icon}</span>
        <span className="resource-meter__label">{label}</span>
        {detail && <span className="resource-meter__detail">{detail}</span>}
        <span
          className="resource-meter__value"
          style={{ color: resourceLoadColor(percent) }}
        >
          {formatPercent(percent)}
        </span>
      </div>
      <div
        className="resource-meter__track"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="resource-meter__fill"
          style={{
            width: `${percent}%`,
            background: resourceLoadColor(percent),
          }}
        />
      </div>
    </div>
  );
}

function CompactValue({
  icon,
  percent,
}: {
  icon: React.ReactNode;
  percent: number;
}) {
  return (
    <span
      className="resource-meter__compact-value"
      style={{ color: resourceLoadColor(percent) }}
    >
      {icon}
      {formatPercent(percent)}
    </span>
  );
}

/** CPU, memória e disco desta máquina, no pé do sidebar. */
export function SystemResourceMeter({ collapsed }: SystemResourceMeterProps) {
  const usage = useResourceUsage();

  if (!usage) {
    return null;
  }

  const { memory, disk } = usage;
  const memoryText = formatUsage(memory.usedBytes, memory.totalBytes);
  const summary = [
    `CPU ${formatPercent(usage.cpuPercent)}`,
    `Memória ${memoryText} (${formatPercent(memory.percent)})`,
    disk
      ? `Disco ${disk.label} ${formatUsage(disk.usedBytes, disk.totalBytes)} (${formatPercent(disk.percent)})`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (collapsed) {
    return (
      <div
        className="resource-meter resource-meter--compact"
        title={summary}
        aria-label={summary}
      >
        <CompactValue icon={<IconCpu size={11} />} percent={usage.cpuPercent} />
        <CompactValue
          icon={<IconMemory size={11} />}
          percent={memory.percent}
        />
        {disk && (
          <CompactValue icon={<IconDisk size={11} />} percent={disk.percent} />
        )}
      </div>
    );
  }

  return (
    <div className="resource-meter" title={summary}>
      <MeterRow
        icon={<IconCpu size={12} />}
        label="CPU"
        percent={usage.cpuPercent}
      />
      <MeterRow
        icon={<IconMemory size={12} />}
        label="Memória"
        detail={memoryText}
        percent={memory.percent}
      />
      {/* Sem a linha de disco quando o volume não respondeu — melhor omitir
          do que mostrar 0% de um disco que não foi lido. */}
      {disk && (
        <MeterRow
          icon={<IconDisk size={12} />}
          label={`Disco ${disk.label}`}
          detail={formatUsage(disk.usedBytes, disk.totalBytes)}
          percent={disk.percent}
        />
      )}
    </div>
  );
}
