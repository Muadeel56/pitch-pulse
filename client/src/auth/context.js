import { createContext } from 'react'

// Kept in its own file so AuthProvider.jsx only exports components (keeps
// react-refresh / fast-refresh happy).
export const AuthContext = createContext(null)
