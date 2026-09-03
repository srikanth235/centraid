import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useMemo, useState } from "react";

import type { RootStackParamList } from "../../navigation";
import {
  buildLauncherItems,
  orderByPins,
  orderForSpringboard,
} from "./catalog";
import type { LauncherItem } from "./catalog";
import { usePins } from "./home-pins";
import SearchOverlay from "./SearchOverlay";
import { VaultChromeContext } from "./vault-chrome-context";
import type { VaultChrome } from "./vault-chrome-context";
import VaultsSwitcher from "./VaultsSwitcher";

export default function VaultChromeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const pins = usePins();
  const [searchOpen, setSearchOpen] = useState(false);
  const [vaultsOpen, setVaultsOpen] = useState(false);

  const items = useMemo(
    () => orderByPins(orderForSpringboard(buildLauncherItems()), pins),
    [pins]
  );

  const chrome = useMemo<VaultChrome>(
    () => ({
      openNewChat: () => navigation.navigate("Assistant"),
      openSearch: () => setSearchOpen(true),
      openVaults: () => setVaultsOpen(true),
    }),
    [navigation]
  );

  const openItem = (item: LauncherItem): void => {
    setSearchOpen(false);
    const { route } = item;
    switch (route.kind) {
      case "photos":
        navigation.navigate("Photos", { screen: "PhotosHome" });
        break;
      case "docs":
        navigation.navigate("Docs", { screen: "DocsHome" });
        break;
      case "agenda":
        navigation.navigate("Agenda", { screen: "AgendaHome" });
        break;
      case "locker":
        navigation.navigate("Locker", { screen: "LockerHome" });
        break;
      case "tasks":
        navigation.navigate("Tasks");
        break;
      case "people":
        navigation.navigate("People", { screen: "PeopleHome" });
        break;
      case "notes":
        navigation.navigate("Notes");
        break;
      case "tally":
        navigation.navigate("Tally", { screen: "TallyHome" });
        break;
    }
  };

  return (
    <VaultChromeContext.Provider value={chrome}>
      {children}
      {searchOpen ? (
        <SearchOverlay
          items={items}
          onOpen={openItem}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      <VaultsSwitcher
        open={vaultsOpen}
        onClose={() => setVaultsOpen(false)}
        onPairDesktop={() =>
          navigation.navigate("Settings", { screen: "SettingsHome" })
        }
      />
    </VaultChromeContext.Provider>
  );
}
