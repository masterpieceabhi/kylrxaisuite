/**
 * People-data modules under /api/us: org structure (locations, departments, managers, org chart, pay schedules, holidays),
 * roles and permissions admin, custom fields, self-service profile edits and change requests,
 * job and compensation history, direct deposit splits, contractors (W-9, 1099).
 * Sign-in is checked once here; each sub-router decides who may do what with services/permissions.js.
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');

router.use(verifyToken);
router.use(require('./us-org'));
router.use(require('./us-roles'));
router.use(require('./us-people-self'));
router.use(require('./us-comp'));
router.use(require('./us-contractors'));
router.use(require('./us-tags'));

module.exports = router;
