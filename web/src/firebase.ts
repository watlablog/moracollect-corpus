import { initializeApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'

let authInstance: Auth | null = null

function requiredEnv(key: string): string {
  const value = import.meta.env[key]
  if (!value || typeof value !== 'string') {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

export function initializeFirebaseAuth(): Auth {
  if (authInstance) {
    return authInstance
  }

  const app = initializeApp({
    apiKey: requiredEnv('VITE_FIREBASE_API_KEY'),
    authDomain: requiredEnv('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: requiredEnv('VITE_FIREBASE_PROJECT_ID'),
    appId: requiredEnv('VITE_FIREBASE_APP_ID'),
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || undefined,
  })

  authInstance = getAuth(app)
  return authInstance
}
