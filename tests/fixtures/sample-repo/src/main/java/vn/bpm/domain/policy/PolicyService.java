package vn.bpm.domain.policy;

import vn.bpm.domain.fact.LoanFact;

/** Service xét điều kiện policy (fixture). */
public class PolicyService {

    private final PolicyInputMapper inputMapper = new PolicyInputMapper();

    public String checkPolicy(LoanFact fact) {
        PolicyInput input = inputMapper.map(fact);
        if ("FURNITURE".equals(input.getPurposeOfLoan())) {
            return "ELIGIBLE";
        }
        if ("REPAIR_NO_STRUCTURE_CHANGE".equals(input.getPurposeOfLoan())) {
            return "ELIGIBLE";
        }
        return "REFER";
    }
}
