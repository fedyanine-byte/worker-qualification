// shared.js — Firestore wiring shared by all pages. Loaded as an ES module.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, onSnapshot,
  collection, addDoc, serverTimestamp, writeBatch, getDocs, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export {
  doc, setDoc, getDoc, updateDoc, onSnapshot,
  collection, addDoc, serverTimestamp, writeBatch, getDocs, deleteDoc
};

// one active game, fixed id keeps old sessions from colliding across resets
export const GAME = 'class';
export const gref = () => doc(db, 'games', GAME);
export const pcol = () => collection(db, 'games', GAME, 'players');
export const pref = (id) => doc(db, 'games', GAME, 'players', id);
export const polcol = () => collection(db, 'games', GAME, 'policies');
export const evcol = () => collection(db, 'games', GAME, 'events');

export function uid() {
  let id = null;
  try { id = localStorage.getItem('wq_uid'); } catch (e) {}
  if (!id) { id = 'u' + Math.random().toString(36).slice(2, 9); try { localStorage.setItem('wq_uid', id); } catch (e) {} }
  return id;
}

export async function logEvent(type, message) {
  try { await addDoc(evcol(), { type, message, ts: serverTimestamp() }); } catch (e) {}
}
