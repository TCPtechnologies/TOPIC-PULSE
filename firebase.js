// Firebase (Auth + Firestore) for the website. Same project and data as the Android app.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
export {
  doc, collection, query, orderBy, limit, startAfter, onSnapshot, getDoc, getDocs,
  setDoc, updateDoc, serverTimestamp, writeBatch,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
