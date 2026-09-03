import * as Network from "expo-network";

export async function currentNetworkType(): Promise<string | undefined> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.type === undefined ? undefined : String(state.type);
  } catch {
    return undefined;
  }
}
