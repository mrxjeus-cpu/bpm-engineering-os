package vn.bpm.domain.policy;

import vn.bpm.domain.fact.LoanFact;

/**
 * Map LoanFact sang PolicyInput.
 * Nguyên tắc kiến trúc: mọi field input của policy đi qua mapper này.
 */
public class PolicyInputMapper {

    public PolicyInput map(LoanFact fact) {
        PolicyInput input = new PolicyInput();
        input.setPurposeOfLoan(fact.getPurposeOfLoan());
        input.setCollateralType(fact.getCollateralType());
        input.setLoanAmount(fact.getLoanAmount());
        return input;
    }
}
