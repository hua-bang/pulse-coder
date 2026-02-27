import { DiscordDmGateway, type DiscordGatewayStatus } from './gateway.js';

const discordGateway = new DiscordDmGateway();

export function startDiscordGateway(): void {
  discordGateway.start();
}

export function stopDiscordGateway(): void {
  discordGateway.stop();
}

export function restartDiscordGateway(): DiscordGatewayStatus {
  discordGateway.restart();
  return discordGateway.getStatus();
}

export function getDiscordGatewayStatus(): DiscordGatewayStatus {
  return discordGateway.getStatus();
}
