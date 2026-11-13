const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { getCountryConfig } = require('../country-config');

router.use(verifyToken);

/**
 * GET /api/org/profile
 * The caller's organization with its country configuration (currency, ID labels, hidden pages,
 * payroll provider). Any signed-in member of the organization may read it.
 */
router.get('/profile', async (req, res) => {
    const orgId = req.user.orgId || req.tenantOrgId;
    if (!orgId) {
        return res.status(404).json({ success: false, error: 'No organization for this user' });
    }
    try {
        const snap = await rawCollection('organizations').doc(orgId).get();
        const exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
        const data = exists ? snap.data() : {};
        const country = getCountryConfig(data.country || data.Country);
        res.json({
            success: true,
            orgId,
            name: data.displayName || data.Display_Name || data.name || orgId,
            orgConfigured: data.orgConfigured === true,
            country
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Could not load organization' });
    }
});

module.exports = router;
