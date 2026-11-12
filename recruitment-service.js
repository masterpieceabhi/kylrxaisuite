import { db, storage, onSnapshot, registerListener } from "./firebase-config.js";
import { collection, doc, addDoc, updateDoc, getDocs, getDoc, setDoc, serverTimestamp, query, orderBy } from "./firebase-config.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-storage.js";

export const STAGES = ["Applied", "Screening", "Interview", "Offer", "Hired", "Rejected"];
export const INTERVIEW_ROUNDS = ["Phone Screen", "Technical", "HR", "Final"];

export function subscribeCandidates(callback, onError) {
    const q = query(collection(db, "candidates"), orderBy("createdAt", "desc"));
    return onSnapshot(q, (snap) => {
        const candidates = snap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .filter((c) => c.status !== "archived");
        callback(candidates);
    }, (err) => {
        console.warn("[RECRUITMENT] Snapshot error, falling back:", err);
        loadCandidates().then(callback).catch(onError || console.error);
    });
}

export async function loadCandidates() {
    const snap = await getDocs(query(collection(db, "candidates"), orderBy("createdAt", "desc")));
    return snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((c) => c.status !== "archived");
}

export async function addCandidate(data) {
    const payload = {
        name: data.name,
        role: data.role,
        email: data.email || "",
        phone: data.phone || "",
        source: data.source || "Direct",
        department: data.department || "",
        expectedCtc: data.expectedCtc || "",
        notes: data.notes || "",
        stage: data.stage || "Applied",
        status: "active",
        stageHistory: [{ stage: data.stage || "Applied", at: new Date().toISOString(), by: "HR" }],
        offer: null,
        linkedUserId: null,
        onboardingStatus: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };
    const refDoc = await addDoc(collection(db, "candidates"), payload);
    return refDoc.id;
}

export async function updateCandidate(id, patch, options = {}) {
    const existing = (await getDoc(doc(db, "candidates", id))).data() || {};
    const updates = { ...patch, updatedAt: serverTimestamp() };

    if (patch.stage && patch.stage !== existing.stage) {
        const history = existing.stageHistory || [];
        updates.stageHistory = [
            ...history,
            { stage: patch.stage, at: new Date().toISOString(), by: options.by || "HR" }
        ];

        // Automatic Onboarding Trigger when stage changes to "Offer"
        if (patch.stage === "Offer") {
            try {
                if (!existing.linkedUserId) {
                    const onboardingToken = `HRFLOW-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
                    const expiryDate = new Date();
                    expiryDate.setDate(expiryDate.getDate() + 3); // 3-day validation
                    const empId = `emp_${Math.random().toString(36).substr(2, 9)}`;

                    const empData = {
                        fullName: existing.name,
                        name: existing.name,
                        email: (existing.email || "").toLowerCase(),
                        personalEmail: (existing.email || "").toLowerCase(),
                        phoneNumber: existing.phone || "",
                        designation: existing.role,
                        department: existing.department || "General",
                        employmentType: "Full-time",
                        status: "Invitation Sent",
                        onboardingStatus: "Invitation Sent",
                        onboardingToken,
                        onboardingTokenExpiry: expiryDate.toISOString(),
                        role: "employee",
                        hiredFromCandidateId: id,
                        pendingDocuments: ['Identity Proof', 'Address Proof', 'Academic Certificates'],
                        reminderCount: 0,
                        createdAt: new Date().toISOString()
                    };

                    await setDoc(doc(db, "users", empId), empData);
                    updates.linkedUserId = empId;
                    updates.onboardingStatus = "invited";

                    const inviteLink = `${window.location.origin}/onboarding-invite.html?token=${onboardingToken}&id=${empId}`;
                    const deadline = expiryDate.toLocaleDateString((window.KylrxFmt ? KylrxFmt.locale() : 'en-IN'), { day: '2-digit', month: 'short', year: 'numeric' });
                    const emailBody = `
                        <div style="font-family: 'Outfit', sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e5e7eb; border-radius: 20px; background-color: #ffffff;">
                            <div style="text-align: center; margin-bottom: 20px;">
                                <h2 style="color: #4f46e5; font-weight: 800; font-size: 1.6rem; margin-bottom: 5px;">Kylrx AI Enterprise</h2>
                                <p style="color: #10b981; font-size: 0.9rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; margin: 0;">Employment Offer Released</p>
                            </div>
                            <hr style="border: 0; border-top: 1px solid #e5e7eb; margin-bottom: 25px;" />
                            <p>Dear <strong>${existing.name}</strong>,</p>
                            <p>Congratulations! We are thrilled to offer you the position of <strong>${existing.role}</strong> at Kylrx AI Enterprise.</p>
                            <p>To begin your onboarding journey, please activate your profile and submit your documents using our secure portal. Note that you can temporarily skip any documents that are currently unavailable.</p>
                            
                            <div style="background-color: #f9fafb; border-radius: 12px; padding: 15px; margin: 20px 0; border-left: 4px solid #10b981;">
                                <h4 style="margin: 0 0 5px; color: #1f2937;">Onboarding Instructions:</h4>
                                <ol style="margin: 0; padding-left: 20px; color: #4b5563; font-size: 0.9rem; line-height: 1.6;">
                                    <li>Click the secure link below to activate your employee ID.</li>
                                    <li>Provide your residential and banking details.</li>
                                    <li>Upload mandatory proofs (Identity, Address, Academic).</li>
                                </ol>
                                <p style="margin: 10px 0 0; color: #ef4444; font-size: 0.8rem; font-weight: bold;">
                                    ⚠️ Completion Deadline: ${deadline}
                                </p>
                            </div>

                            <div style="margin: 30px 0; text-align: center;">
                                <a href="${inviteLink}" 
                                   style="background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 12px; font-weight: bold; display: inline-block; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);">
                                   Activate Profile & Onboard
                                </a>
                            </div>

                            <p style="font-size: 0.85rem; color: #6b7280; line-height: 1.5;">If you have any questions or require support, please reply to this email or contact human resources.</p>
                            <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 25px 0 15px;" />
                            <p style="font-size: 0.7rem; color: #9ca3af; text-align: center;">Kylrx AI HR Administration • Private and Confidential</p>
                        </div>
                    `;

                    fetch('/api/email/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            to: existing.email,
                            subject: `Congratulations! Your Offer is Released at Kylrx AI`,
                            html: emailBody
                        })
                    }).then(res => res.json())
                      .then(resData => console.log('[RECRUITMENT] Onboarding email dispatch response:', resData))
                      .catch(err => console.error('[RECRUITMENT] Failed to dispatch onboarding email:', err));
                }
            } catch (onboardErr) {
                console.error('[RECRUITMENT] Automatic onboarding trigger failed:', onboardErr);
            }
        }
    }

    await updateDoc(doc(db, "candidates", id), updates);
}

export async function deleteCandidate(id) {
    await updateDoc(doc(db, "candidates", id), {
        status: "archived",
        archivedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });
}

export async function uploadResume(candidateId, file) {
    const ext = file.name.split(".").pop() || "pdf";
    const storagePath = `recruitment/resumes/${candidateId}.${ext}`;
    const storageRef = ref(storage, storagePath);
    await uploadBytes(storageRef, file);
    const resumeUrl = await getDownloadURL(storageRef);
    await updateDoc(doc(db, "candidates", candidateId), {
        resumeUrl,
        resumeFileName: file.name,
        updatedAt: serverTimestamp()
    });
    return { resumeUrl, resumeFileName: file.name };
}

export async function getInterviews(candidateId) {
    const snap = await getDocs(collection(db, "candidates", candidateId, "interviews"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function addInterview(candidateId, interviewData) {
    const payload = {
        round: interviewData.round || "Phone Screen",
        scheduledAt: interviewData.scheduledAt || null,
        interviewer: interviewData.interviewer || "",
        locationOrLink: interviewData.locationOrLink || "",
        status: interviewData.status || "Scheduled",
        feedback: interviewData.feedback || "",
        rating: interviewData.rating || null,
        createdAt: serverTimestamp()
    };
    const interviewRef = await addDoc(collection(db, "candidates", candidateId, "interviews"), payload);

    if (payload.scheduledAt) {
        await addDoc(collection(db, "recruitment_events"), {
            candidateId,
            interviewId: interviewRef.id,
            type: "interview",
            title: `${payload.round} — ${interviewData.candidateName || "Candidate"}`,
            scheduledAt: payload.scheduledAt,
            interviewer: payload.interviewer,
            locationOrLink: payload.locationOrLink,
            createdAt: serverTimestamp()
        });
    }

    return interviewRef.id;
}

export async function updateOffer(candidateId, offerData) {
    await updateDoc(doc(db, "candidates", candidateId), {
        offer: {
            ctc: offerData.ctc || "",
            joiningDate: offerData.joiningDate || "",
            status: offerData.status || "Draft",
            sentAt: offerData.sentAt || null
        },
        updatedAt: serverTimestamp()
    });
}

export async function startOnboarding(candidateId) {
    const candSnap = await getDoc(doc(db, "candidates", candidateId));
    if (!candSnap.exists()) throw new Error("Candidate not found");
    const c = candSnap.data();

    const onboardingToken = `HRFLOW-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + 3);
    const empId = `emp_${Math.random().toString(36).substr(2, 9)}`;

    const empData = {
        fullName: c.name,
        name: c.name,
        email: (c.email || "").toLowerCase(),
        phoneNumber: c.phone || "",
        designation: c.role,
        department: c.department || "General",
        employmentType: "Full-time",
        status: "Invitation Sent",
        onboardingStatus: "Invitation Sent",
        onboardingToken,
        onboardingTokenExpiry: expiryDate,
        role: "employee",
        hiredFromCandidateId: candidateId,
        createdAt: serverTimestamp()
    };

    await setDoc(doc(db, "users", empId), empData);
    await updateCandidate(candidateId, {
        stage: "Hired",
        linkedUserId: empId,
        onboardingStatus: "invited"
    }, { by: "Onboarding" });

    const inviteLink = `${window.location.origin}/onboarding-invite.html?token=${onboardingToken}&id=${empId}`;
    return { empId, inviteLink, onboardingToken };
}

export function filterCandidates(candidates, filters = {}) {
    const term = (filters.search || "").toLowerCase().trim();
    return candidates.filter((c) => {
        if (filters.stage && filters.stage !== "all" && c.stage !== filters.stage) return false;
        if (filters.source && filters.source !== "all" && c.source !== filters.source) return false;
        if (!term) return true;
        return [c.name, c.role, c.email, c.department, c.source]
            .some((v) => (v || "").toLowerCase().includes(term));
    });
}

export async function getUpcomingInterviews(days = 7) {
    const candidates = await loadCandidates();
    const upcoming = [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    for (const c of candidates) {
        const interviews = await getInterviews(c.id);
        interviews.forEach((iv) => {
            if (!iv.scheduledAt || iv.status === "Cancelled") return;
            const dt = iv.scheduledAt.toDate ? iv.scheduledAt.toDate() : new Date(iv.scheduledAt);
            if (dt >= new Date() && dt <= cutoff) {
                upcoming.push({ ...iv, candidateId: c.id, candidateName: c.name, candidateRole: c.role, scheduledDate: dt });
            }
        });
    }

    return upcoming.sort((a, b) => a.scheduledDate - b.scheduledDate);
}
