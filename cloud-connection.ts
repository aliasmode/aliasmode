import { CloudClient, type CloudFetch } from "./cloud-client.ts";
import type { BootstrapResponse, CloudDevice } from "./contracts/cloud-v1.ts";

export interface CloudInstallation {
  installationId: string;
  label: string;
  platform: CloudDevice["platform"];
  appVersion: string;
}

export class CloudConnectionRuntime {
  readonly client: CloudClient;
  private deviceCredentialValue: string | undefined;
  private deviceIdValue: string | undefined;
  private accountIdValue: string | undefined;

  constructor(options: {
    baseUrl: string;
    accessToken: () => string | undefined | Promise<string | undefined>;
    installation: CloudInstallation;
    fetchFn?: CloudFetch;
  }) {
    this.installation = options.installation;
    this.client = new CloudClient({
      baseUrl: options.baseUrl,
      accessToken: options.accessToken,
      deviceCredential: () => this.deviceCredentialValue,
      fetchFn: options.fetchFn,
    });
  }

  private readonly installation: CloudInstallation;

  accountId(): string | undefined {
    return this.accountIdValue;
  }

  deviceId(): string | undefined {
    return this.deviceIdValue;
  }

  deviceCredential(): string | undefined {
    return this.deviceCredentialValue;
  }

  async bootstrap(accept: () => boolean = () => true): Promise<BootstrapResponse> {
    const response = await this.client.bootstrap({ device: this.installation });
    if (!accept()) throw new Error("Cloud authentication was cancelled");
    this.accountIdValue = response.account.id;
    this.deviceIdValue = response.device.id;
    if (response.deviceCredential) this.deviceCredentialValue = response.deviceCredential;
    return response;
  }

  restoreCredential(credential: string): void {
    if (!credential) throw new Error("device credential is required");
    this.deviceCredentialValue = credential;
  }

  restoreDevice(deviceId: string, credential: string): void {
    if (!deviceId || !credential) throw new Error("device id and credential are required");
    this.deviceIdValue = deviceId;
    this.deviceCredentialValue = credential;
  }

  restoreAccount(accountId: string): void {
    if (!accountId) throw new Error("account id is required");
    this.accountIdValue = accountId;
  }

  clearDevice(): void {
    this.accountIdValue = undefined;
    this.deviceIdValue = undefined;
    this.deviceCredentialValue = undefined;
  }
}
