import { DateTime } from 'luxon';

function toFormat(date: string, format = 'dd/MM/yyyy') {
  return DateTime.fromISO(date).toUTC().toFormat(format);
}

function isoToTimestamp(iso8601Date: string) {
  return DateTime.fromISO(iso8601Date).toMillis();
}

function secToDays(secs: number) {
  const segundosEmUmDia = 86400;
  return secs / segundosEmUmDia;
}

function unixToTimestamp(unixTime: number) {
  return unixTime * 1000;
}

function timestampUntil(dateString: string | number) {
  if (!dateString) return 0;
  const now = new Date();
  const targetDate = new Date(dateString);
  if (isNaN(targetDate.getTime())) {
    console.error('Invalid date string provided.');
    return 0;
  }
  const differenceInMilliseconds = targetDate.getTime() - now.getTime();
  return differenceInMilliseconds;
}

function timestampToDateString(date: Date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function timestampToDate(timestamp: number) {
  const days = Math.floor(timestamp / (24 * 3600 * 1000));
  const remainingAfterDays = timestamp % (24 * 3600 * 1000);
  const hours = Math.floor(remainingAfterDays / (3600 * 1000));
  const remainingAfterHours = remainingAfterDays % (3600 * 1000);
  const minutes = Math.floor(remainingAfterHours / (60 * 1000));
  const seconds = Math.floor((remainingAfterHours % (60 * 1000)) / 1000);

  return {
    days,
    hours,
    minutes,
    seconds,
  };
}

function dateToTimestamp(date: string) {
  return Math.floor(new Date(date).getTime() / 1000);
}

export const DateFormat = {
  toFormat,
  timestampToDateString,
  isoToTimestamp,
  secToDays,
  timestampUntil,
  timestampToDate,
  unixToTimestamp,
  dateToTimestamp,
};
