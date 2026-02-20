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

function resolveAuthDomain(configuredAuthDomain: string): string {
  if (typeof window === 'undefined') {
    return configuredAuthDomain
  }

  const host = window.location.hostname
  if (host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) {
    return host
  }

  return configuredAuthDomain
}

export function initializeFirebaseAuth(): Auth {
  if (authInstance) {
    return authInstance
  }

  const configuredAuthDomain = requiredEnv('VITE_FIREBASE_AUTH_DOMAIN')

  const app = initializeApp({
    apiKey: requiredEnv('VITE_FIREBASE_API_KEY'),
    authDomain: resolveAuthDomain(configuredAuthDomain),
    projectId: requiredEnv('VITE_FIREBASE_PROJECT_ID'),
    appId: requiredEnv('VITE_FIREBASE_APP_ID'),
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || undefined,
  })

  authInstance = getAuth(app)
  return authInstance
}
