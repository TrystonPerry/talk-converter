export function timeToSeconds(time: string) {
  const parts = time.split(":");

  if (parts.length === 1) {
    // Just seconds
    return parseInt(parts[0]);
  } else if (parts.length === 2) {
    // Minutes and seconds
    const [minutes, seconds] = parts;
    return parseInt(minutes) * 60 + parseInt(seconds);
  } else if (parts.length === 3) {
    // Hours, minutes and seconds
    const [hours, minutes, seconds] = parts;
    return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);
  }

  throw new Error("Invalid time format");
}
