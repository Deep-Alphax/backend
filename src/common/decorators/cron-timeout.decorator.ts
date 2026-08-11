import { Logger } from '@nestjs/common';

export function CronTimeout(timeoutMs = 30000) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    const logger = new Logger(`CronTimeout:${target.constructor.name}`);

    descriptor.value = async function (...args: any[]) {
      return new Promise(async (resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const message = `Cron task ${propertyKey} timed out after ${timeoutMs}ms`;
          logger.error(message);
          resolve({ success: false, error: message });
        }, timeoutMs);

        try {
          const result = await originalMethod.apply(this, args);
          clearTimeout(timeoutId);
          resolve(result);
        } catch (error) {
          clearTimeout(timeoutId);
          logger.error(
            `Error in cron task ${propertyKey}: ${error.message}`,
            error.stack,
          );
          resolve({ success: false, error: error.message });
        }
      });
    };

    return descriptor;
  };
}
