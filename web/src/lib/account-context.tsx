"use client";
import { createContext, useContext } from "react";
import type { Account } from "./auth-navigation";
export const WebAccountContext = createContext<Account | null>(null);
export const useWebAccount = () => useContext(WebAccountContext);
