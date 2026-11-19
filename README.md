[![Pipeline](https://github.com/kworathur/quaid-backend/actions/workflows/pipeline.yaml/badge.svg)](https://github.com/kworathur/quaid-backend/actions/workflows/pipeline.yaml)

# Background Checks API

Verify that college applications and need-based aid applications come from real students - not bad actors.

Features:
- Integrates with student information systems (e.g. Banner)
- Detect fraud in Free Application for Federal Student Aid (FAFSA) applications
- Integrate with student resources in SIS to automatically place holds on registration
- Uses multiple datapoints for background checks - address liveness, program of study sanity checks, ML-model scoring
